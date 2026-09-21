-- New migration; 0001/0002 remain intact.
DROP TRIGGER reservoir_claim;
CREATE TABLE smwu_readings_new (
 reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
 id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 reservoir_id INTEGER REFERENCES reservoirs(id) ON DELETE CASCADE,
 distancia REAL NOT NULL CHECK(distancia BETWEEN 0 AND 1000000),
 nivel REAL NOT NULL CHECK(nivel BETWEEN 0 AND 100),
 volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1000000000000),
 rssi_wifi REAL NOT NULL CHECK(rssi_wifi BETWEEN -200 AND 0),
 created_at INTEGER NOT NULL, event_key TEXT, payload_hash TEXT
);
INSERT INTO smwu_readings_new(reading_id,id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at)
 SELECT reading_id,id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at FROM smwu_readings;
DROP TABLE smwu_readings;
ALTER TABLE smwu_readings_new RENAME TO smwu_readings;
CREATE INDEX readings_reservoir ON smwu_readings(reservoir_id,created_at,reading_id);
CREATE INDEX readings_device ON smwu_readings(id,created_at);
CREATE INDEX readings_retention ON smwu_readings(created_at,reading_id);
CREATE UNIQUE INDEX readings_event ON smwu_readings(id,event_key) WHERE event_key IS NOT NULL;
ALTER TABLE smwa_readings ADD COLUMN event_key TEXT;
ALTER TABLE smwa_readings ADD COLUMN payload_hash TEXT;
CREATE UNIQUE INDEX smwa_event ON smwa_readings(id,event_key) WHERE event_key IS NOT NULL;
CREATE INDEX smwa_retention ON smwa_readings(created_at,reading_id);
CREATE TABLE device_credentials (
 device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 version INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE mutation_guard (value INTEGER NOT NULL CHECK(value=1));
-- Unowned telemetry is never inherited, including after account erasure.
CREATE TRIGGER reservoir_claim AFTER INSERT ON reservoirs BEGIN
 UPDATE devices SET owner_user_id=NEW.user_id,pairing_code_hash=NULL,pairing_expires_at=NULL,
 updated_at=NEW.created_at WHERE id=NEW.device_id;
END;
CREATE TRIGGER device_erase BEFORE DELETE ON devices BEGIN
 DELETE FROM reservoirs WHERE device_id=OLD.id;
END;
CREATE TRIGGER account_erase BEFORE DELETE ON users BEGIN
 UPDATE devices SET pairing_code_hash=NULL,pairing_expires_at=NULL WHERE owner_user_id=OLD.id;
 UPDATE device_credentials SET revoked_at=unixepoch(),updated_at=unixepoch()
 WHERE device_id IN (SELECT id FROM devices WHERE owner_user_id=OLD.id);
END;
