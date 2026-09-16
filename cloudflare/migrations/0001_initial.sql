-- D1 / SQLite. Datas em segundos UTC. Banco vazio; nenhum seed em produção.
CREATE TABLE users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 120),
 email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL,
 session_version INTEGER NOT NULL DEFAULT 1,
 last_login_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY,
 previous_hash TEXT UNIQUE,
 previous_until INTEGER,
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 session_version INTEGER NOT NULL DEFAULT 1,
 csrf_token TEXT NOT NULL,
 remember INTEGER NOT NULL DEFAULT 0 CHECK(remember IN (0,1)),
 read_only INTEGER NOT NULL DEFAULT 0 CHECK(read_only IN (0,1)),
 created_at INTEGER NOT NULL,
 last_seen INTEGER NOT NULL,
 rotated_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE password_reset_tokens (
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX reset_user ON password_reset_tokens(user_id, used_at);
CREATE INDEX reset_expiry ON password_reset_tokens(expires_at);
-- O UPDATE condicional da senha e estas invalidações são UMA transação SQLite.
CREATE TRIGGER revoke_on_password_change AFTER UPDATE OF password_hash ON users
WHEN NEW.password_hash <> OLD.password_hash
BEGIN
 DELETE FROM sessions WHERE user_id = NEW.id;
 UPDATE password_reset_tokens SET used_at = NEW.updated_at WHERE user_id = NEW.id AND used_at IS NULL;
END;
CREATE TABLE rate_limits (
 key_hash TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX rate_expiry ON rate_limits(expires_at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE devices (
 id INTEGER PRIMARY KEY CHECK(id > 0),
 device_code TEXT NOT NULL UNIQUE,
 source TEXT NOT NULL CHECK(source IN ('monitorie','local','mock')),
 external_id TEXT,
 owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 pairing_code_hash TEXT UNIQUE,
 pairing_expires_at INTEGER,
 reported_status TEXT NOT NULL DEFAULT 'offline' CHECK(reported_status IN ('online','offline')),
 last_seen INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX devices_external ON devices(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX devices_owner ON devices(owner_user_id);
CREATE TABLE reservoirs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id INTEGER NOT NULL REFERENCES devices(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 capacity_liters REAL CHECK(capacity_liters IS NULL OR capacity_liters > 0),
 linked_at INTEGER NOT NULL,
 unlinked_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX reservoir_one_owner ON reservoirs(device_id) WHERE unlinked_at IS NULL;
CREATE INDEX reservoirs_user ON reservoirs(user_id, unlinked_at, id);
CREATE TABLE smwu_readings (
 reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
 id INTEGER NOT NULL REFERENCES devices(id),
 reservoir_id INTEGER REFERENCES reservoirs(id),
 distancia REAL NOT NULL CHECK(distancia BETWEEN 0 AND 1000000),
 nivel REAL NOT NULL CHECK(nivel BETWEEN 0 AND 100),
 volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1000000000000),
 rssi_wifi REAL NOT NULL CHECK(rssi_wifi BETWEEN -200 AND 0),
 created_at INTEGER NOT NULL
);
CREATE INDEX readings_reservoir ON smwu_readings(reservoir_id, created_at DESC, reading_id DESC);
CREATE INDEX readings_device ON smwu_readings(id, created_at DESC);
CREATE INDEX readings_retention ON smwu_readings(created_at);
CREATE TRIGGER reservoir_claim AFTER INSERT ON reservoirs
BEGIN
 UPDATE devices SET owner_user_id = NEW.user_id, pairing_code_hash = NULL,
 pairing_expires_at = NULL, updated_at = NEW.created_at WHERE id = NEW.device_id;
 -- Atribui leituras locais ainda sem proprietário apenas no PRIMEIRO vínculo.
 UPDATE smwu_readings SET reservoir_id = NEW.id WHERE id = NEW.device_id AND reservoir_id IS NULL
 AND NOT EXISTS (SELECT 1 FROM reservoirs r WHERE r.device_id = NEW.device_id AND r.id <> NEW.id);
END;
CREATE TRIGGER reservoir_release AFTER UPDATE OF unlinked_at ON reservoirs
WHEN OLD.unlinked_at IS NULL AND NEW.unlinked_at IS NOT NULL
BEGIN
 UPDATE devices SET owner_user_id = NULL, pairing_code_hash = NULL, pairing_expires_at = NULL,
 updated_at = NEW.updated_at WHERE id = NEW.device_id AND owner_user_id = NEW.user_id;
END;
