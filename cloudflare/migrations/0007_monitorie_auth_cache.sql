CREATE TABLE monitorie_auth_cache (
 id INTEGER PRIMARY KEY CHECK(id=1),
 sealed TEXT,
 nonce TEXT,
 force_refresh INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL DEFAULT 0
);
