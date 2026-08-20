PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    reported_status TEXT NOT NULL DEFAULT 'offline' CHECK (reported_status IN ('online', 'offline')),
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);

CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id INTEGER NOT NULL,
    ppl REAL NOT NULL CHECK (ppl >= 0),
    vazao REAL NOT NULL CHECK (vazao >= 0),
    consumo REAL NOT NULL CHECK (consumo >= 0),
    rssi_wifi REAL NOT NULL CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (id) REFERENCES devices (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_readings_id_created
    ON sensor_readings (id, created_at, reading_id);
CREATE INDEX IF NOT EXISTS idx_readings_created
    ON sensor_readings (created_at, reading_id);
