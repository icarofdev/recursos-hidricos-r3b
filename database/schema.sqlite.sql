PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    reported_status TEXT NOT NULL DEFAULT 'offline' CHECK (reported_status IN ('online', 'offline')),
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);

CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    nivel_cm REAL NOT NULL,
    capacidade_cm REAL NOT NULL CHECK (capacidade_cm > 0),
    percentual REAL NOT NULL CHECK (percentual >= 0 AND percentual <= 100),
    volume_litros REAL NOT NULL CHECK (volume_litros >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
    CHECK (nivel_cm >= 0 AND nivel_cm <= capacidade_cm)
);

CREATE INDEX IF NOT EXISTS idx_readings_device_created
    ON sensor_readings (device_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_readings_created
    ON sensor_readings (created_at, id);

