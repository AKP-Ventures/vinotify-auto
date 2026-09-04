export const LATEST_SCHEMA_VERSION = 3;

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS feed_cursors (
        feed_name TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS feed_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        search_id TEXT NOT NULL,
        search_name TEXT,
        detected_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        inserted_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feed_events_search_detected
        ON feed_events(search_id, detected_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feed_items (
        item_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES feed_events(event_id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        search_id TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        price_minor INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        inserted_at TEXT NOT NULL,
        UNIQUE(search_id, market, item_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feed_items_event ON feed_items(event_id)`,
      `CREATE TABLE IF NOT EXISTS purchase_attempts (
        attempt_id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL UNIQUE REFERENCES feed_items(item_key) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES feed_events(event_id) ON DELETE RESTRICT,
        search_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        market TEXT NOT NULL,
        currency TEXT NOT NULL,
        item_price_minor INTEGER NOT NULL,
        final_total_minor INTEGER,
        order_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_attempts_state_created
        ON purchase_attempts(state, created_at)`,
      `CREATE TABLE IF NOT EXISTS budget_reservations (
        reservation_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES purchase_attempts(attempt_id) ON DELETE RESTRICT,
        day_key TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reservations_day_state
        ON budget_reservations(day_key, currency, state)`,
      `CREATE TABLE IF NOT EXISTS attempt_transitions (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL REFERENCES purchase_attempts(attempt_id) ON DELETE CASCADE,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_transitions_attempt
        ON attempt_transitions(attempt_id, transition_id)`,
      `CREATE TABLE IF NOT EXISTS local_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `ALTER TABLE feed_cursors ADD COLUMN cursor_expires_at TEXT`,
      `ALTER TABLE purchase_attempts ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 3,
    statements: [
      // New feeds warm from the retained stream snapshot before becoming
      // actionable. Existing cursor rows predate that mode and are ready.
      `ALTER TABLE feed_cursors ADD COLUMN warm_start_complete INTEGER NOT NULL DEFAULT 1`,
    ],
  },
]);

export function migrate(db, clock = () => new Date()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => Number(row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, clock().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the migration error */ }
      throw error;
    }
  }
  return LATEST_SCHEMA_VERSION;
}
