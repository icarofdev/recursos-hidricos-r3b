-- Append-only, non-personal tombstones prevent device IDs from being recycled.
-- No device table rebuild, telemetry rewrite or change to existing audit records.
CREATE TABLE device_identities (
 device_id INTEGER PRIMARY KEY,
 identity TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);
INSERT INTO device_identities(device_id,identity,created_at)
 SELECT id,lower(hex(randomblob(16))),created_at FROM devices;
INSERT INTO device_identities(device_id,identity,created_at)
 SELECT device_id,lower(hex(randomblob(16))),MIN(created_at) FROM audit_logs
 WHERE device_id IS NOT NULL AND device_id>0
 AND NOT EXISTS(SELECT 1 FROM device_identities i WHERE i.device_id=audit_logs.device_id)
 GROUP BY device_id;
CREATE TRIGGER device_identity_created AFTER INSERT ON devices BEGIN
 INSERT INTO device_identities(device_id,identity,created_at)
 VALUES(NEW.id,lower(hex(randomblob(16))),NEW.created_at);
END;
CREATE TRIGGER device_identity_no_update BEFORE UPDATE ON device_identities BEGIN
 SELECT RAISE(ABORT,'DEVICE_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER device_identity_no_delete BEFORE DELETE ON device_identities BEGIN
 SELECT RAISE(ABORT,'DEVICE_IDENTITY_IMMUTABLE');
END;
-- Earlier records may already reference a recycled ID. Do not invent an identity
-- or label from today's device for an ambiguous historical event.
INSERT INTO settings(key,value,updated_at)
 SELECT 'audit:identity-first-id',CAST(COALESCE(MAX(id),0)+1 AS TEXT),unixepoch() FROM audit_logs;
ALTER TABLE reservoirs ADD COLUMN configuration_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER reservoir_configuration_changed
 AFTER UPDATE OF capacity_liters,geometry,measurement_config,installation_type ON reservoirs
BEGIN
 UPDATE reservoirs SET configuration_version=OLD.configuration_version+1 WHERE id=NEW.id;
END;
INSERT INTO settings(key,value,updated_at) VALUES('schema_version','14',unixepoch())
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
