-- Preserve authenticated raw distance when geometry cannot produce a volume.
CREATE TABLE smwu_readings_new (
 reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
 id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 reservoir_id INTEGER REFERENCES reservoirs(id) ON DELETE CASCADE,
 distancia REAL NOT NULL CHECK(distancia BETWEEN 0 AND 1000000),
 nivel REAL CHECK(nivel IS NULL OR nivel BETWEEN 0 AND 100),
 volume REAL CHECK(volume IS NULL OR volume BETWEEN 0 AND 1000000000000),
 rssi_wifi REAL NOT NULL CHECK(rssi_wifi BETWEEN -200 AND 0), created_at INTEGER NOT NULL,
 event_key TEXT,payload_hash TEXT,
 measurement_quality TEXT NOT NULL DEFAULT 'reported'
 CHECK(measurement_quality IN ('reported','valid','within_tolerance','out_of_range','configuration_missing','missing')),
 CHECK((nivel IS NOT NULL AND volume IS NOT NULL) OR measurement_quality IN ('out_of_range','configuration_missing','missing'))
);
INSERT INTO smwu_readings_new(reading_id,id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at,event_key,payload_hash)
 SELECT reading_id,id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at,event_key,payload_hash FROM smwu_readings;
DROP TABLE smwu_readings;
ALTER TABLE smwu_readings_new RENAME TO smwu_readings;
CREATE INDEX readings_reservoir ON smwu_readings(reservoir_id,created_at,reading_id);
CREATE INDEX readings_device ON smwu_readings(id,created_at);
CREATE INDEX readings_retention ON smwu_readings(created_at,reading_id);
CREATE UNIQUE INDEX readings_event ON smwu_readings(id,event_key) WHERE event_key IS NOT NULL;
INSERT INTO settings(key,value,updated_at) VALUES('schema_version','13',unixepoch())
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
