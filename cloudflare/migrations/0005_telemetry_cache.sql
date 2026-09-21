CREATE TABLE telemetry_cache (
 cache_key TEXT PRIMARY KEY,
 payload TEXT,
 expires_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 negative_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX telemetry_cache_expiry ON telemetry_cache(expires_at,lease_until,negative_until);
