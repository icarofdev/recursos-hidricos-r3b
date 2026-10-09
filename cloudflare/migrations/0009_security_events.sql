CREATE TABLE security_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id INTEGER,
 account_hash TEXT,
 event_type TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('success','failure')),
 request_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX security_events_account ON security_events(account_id, created_at);
CREATE INDEX security_events_created ON security_events(created_at);
