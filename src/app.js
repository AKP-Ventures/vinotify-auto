import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BrowserExecutor,
  ChromiumController,
  PurchaseQueueBrowserAdapter,
} from "./browser/index.js";
import { RedactedLogger } from "./core/logger.js";
import { PurchasePolicy } from "./core/policy.js";
import { PurchaseQueue } from "./core/queue.js";
import { VinotifyFeedClient } from "./feed/client.js";
import { VinotifySearchDiscoveryClient } from "./feed/discovery.js";
import { FeedIngestor } from "./feed/ingestor.js";
import { AgentRuntime } from "./runtime.js";
import { AgentService, initializeExecutionMode } from "./service.js";
import { LocalDatabase } from "./storage/database.js";
import { AgentStore } from "./storage/repository.js";
import { createControlUi } from "./ui/index.js";

export async function createAgentApp(config) {
  await mkdir(dirname(config.storage.databasePath), { recursive: true, mode: 0o700 });
  const database = new LocalDatabase(config.storage.databasePath);
  const store = new AgentStore(database, {
    maxDatabaseBytes: config.storage.maxDatabaseBytes,
  });
  const logger = new RedactedLogger({ store });
  const policy = new PurchasePolicy(config.purchase);
  const controller = new ChromiumController(config.browser);
  const domExecutor = new BrowserExecutor({ controller });
  const executor = new PurchaseQueueBrowserAdapter({
    executor: domExecutor,
    itemLookup: ({ itemKey }) => store.getItem(itemKey),
  });
  const queue = new PurchaseQueue({ store, policy, executor, logger });

  const makeFeed = (searchId) => {
    const client = new VinotifyFeedClient({
      baseUrl: config.vinotify.baseUrl,
      searchId,
      bearerToken: config.vinotify.bearerToken,
      longPollSeconds: config.vinotify.longPollSeconds,
      requestTimeoutMs: config.vinotify.requestTimeoutMs,
    });
    return {
      searchId,
      ingestor: new FeedIngestor({
        client,
        store,
        feedName: `search-${searchId}`,
        logger,
      }),
    };
  };
  // Discovery is authoritative for account binding, but only the explicit
  // local purchase selection may become a feed or queue membership.
  const searchAllowlist = config.purchase.searchAllowlist;
  const feeds = searchAllowlist.map(makeFeed);
  const discovery = new VinotifySearchDiscoveryClient({
    baseUrl: config.vinotify.baseUrl,
    bearerToken: config.vinotify.bearerToken,
    searchAllowlist,
    requestTimeoutMs: config.vinotify.requestTimeoutMs,
  });
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds,
    feedFactory: makeFeed,
    discoverSearchIds: ({ signal } = {}) => discovery.listSearches({ signal }),
    discoveryRefreshSeconds: config.vinotify.discoveryRefreshSeconds ?? 60,
    maxConcurrentFeeds: config.vinotify.maxConcurrentFeeds ?? 8,
    storageCleanupSeconds: config.storage.cleanupIntervalSeconds ?? 300,
    storageCleanupOptions: {
      attemptRetentionDays: config.storage.attemptRetentionDays,
      logRetentionDays: config.storage.logRetentionDays,
      maxLogRows: config.storage.maxLogRows,
      maxDatabaseBytes: config.storage.maxDatabaseBytes,
      batchSize: config.storage.cleanupBatchSize,
    },
    logger,
    controller,
  });
  const service = new AgentService({
    config,
    queue,
    store,
    runtime,
    runtimeStatus: () => runtime.snapshot(),
  });
  const ui = createControlUi({ service, ...config.ui });

  let started = false;
  return {
    database,
    store,
    queue,
    runtime,
    service,
    ui,
    controller,
    async start() {
      if (started) return { origin: ui.origin };
      initializeExecutionMode({ config, queue, store });
      for (const warning of config.warnings ?? []) logger.warn("config_warning", { warning });

      const { origin } = await ui.start();
      try {
        await controller.navigate("https://www.vinted.co.uk/");
      } catch (error) {
        // Keep the local UI available so the user can see health and retry via
        // the visible browser. Listing execution remains fail-closed.
        logger.warn("initial_vinted_navigation_failed", { reason: error });
      }
      await runtime.start();
      started = true;
      logger.info("agent_started", {
        controlOrigin: origin,
        searches: runtime.feeds.map((feed) => feed.searchId),
        mode: queue.getMode(),
      });
      return { origin };
    },
    async stop(reason = "agent_stopped") {
      queue.disarm(reason);
      await runtime.stop(reason);
      await ui.stop();
      await executor.close();
      database.close();
      started = false;
    },
  };
}
