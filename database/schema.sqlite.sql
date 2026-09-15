PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    device_code TEXT NULL,
    owner_user_id INTEGER NULL,
    pairing_code_hash TEXT NULL,
    pairing_expires_at TEXT NULL,
    paired_at TEXT NULL,
    reported_status TEXT NOT NULL DEFAULT 'offline' CHECK (reported_status IN ('online', 'offline')),
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_device_code ON devices (device_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_pairing_hash ON devices (pairing_code_hash);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices (owner_user_id);

CREATE TABLE IF NOT EXISTS reservoirs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    capacity_liters REAL NULL CHECK (capacity_liters IS NULL OR capacity_liters > 0),
    linked_at TEXT NOT NULL,
    unlinked_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reservoirs_user_active ON reservoirs (user_id, unlinked_at, id);
CREATE INDEX IF NOT EXISTS idx_reservoirs_device_active ON reservoirs (device_id, unlinked_at, id);

CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id INTEGER NOT NULL,
    reservoir_id INTEGER NULL,
    ppl REAL NOT NULL CHECK (ppl >= 0),
    vazao REAL NOT NULL CHECK (vazao >= 0),
    consumo REAL NOT NULL CHECK (consumo >= 0),
    rssi_wifi REAL NOT NULL CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (id) REFERENCES devices (id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (reservoir_id) REFERENCES reservoirs (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_id_created
    ON sensor_readings (id, created_at, reading_id);
CREATE INDEX IF NOT EXISTS idx_readings_created
    ON sensor_readings (created_at, reading_id);
CREATE INDEX IF NOT EXISTS idx_sensor_reservoir_created
    ON sensor_readings (reservoir_id, created_at, reading_id);

CREATE TABLE IF NOT EXISTS smwu_readings (
    reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id INTEGER NOT NULL,
    reservoir_id INTEGER NULL,
    distancia REAL NOT NULL CHECK (distancia >= 0),
    nivel REAL NOT NULL CHECK (nivel >= 0 AND nivel <= 100),
    volume REAL NOT NULL CHECK (volume >= 0),
    rssi_wifi REAL NOT NULL CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (id) REFERENCES devices (id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (reservoir_id) REFERENCES reservoirs (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_smwu_readings_id_created
    ON smwu_readings (id, created_at, reading_id);
CREATE INDEX IF NOT EXISTS idx_smwu_readings_created
    ON smwu_readings (created_at, reading_id);
CREATE INDEX IF NOT EXISTS idx_smwu_reservoir_created
    ON smwu_readings (reservoir_id, created_at, reading_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_hash ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id, expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON rate_limits (updated_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
