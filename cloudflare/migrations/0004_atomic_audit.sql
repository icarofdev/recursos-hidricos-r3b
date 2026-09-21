-- Preserve events; remove identifying free text from existing audit records.
CREATE TABLE audit_logs_new (
 id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
 device_id INTEGER, user_id INTEGER, details TEXT, ip TEXT, created_at INTEGER NOT NULL
);
INSERT INTO audit_logs_new(id,action,device_id,user_id,created_at)
 SELECT id,action,device_id,user_id,created_at FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
CREATE INDEX idx_audit_device ON audit_logs(device_id,created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action,created_at DESC);
CREATE INDEX audit_retention ON audit_logs(created_at,id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN
 SELECT RAISE(ABORT,'AUDIT_IMMUTABLE');
END;
CREATE TRIGGER audit_retention_only BEFORE DELETE ON audit_logs
WHEN OLD.created_at >= unixepoch() - 86400 * COALESCE(
 (SELECT CAST(value AS INTEGER) FROM settings WHERE key='audit_retention_days'),180)
BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
ALTER TABLE activation_codes ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0 CHECK(is_transfer IN (0,1));
UPDATE activation_codes SET revoked_at=unixepoch()
 WHERE used_at IS NULL AND revoked_at IS NULL
 AND (expires_at<=unixepoch() OR NOT EXISTS (
 SELECT 1 FROM devices d WHERE d.id=device_id AND d.pairing_code_hash=code_hash));
CREATE UNIQUE INDEX activation_one_active ON activation_codes(device_id)
 WHERE used_at IS NULL AND revoked_at IS NULL;
DROP TRIGGER reservoir_claim;
CREATE TRIGGER reservoir_claim AFTER INSERT ON reservoirs BEGIN
 INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
 SELECT 'transfer_completed',NEW.device_id,NEW.user_id,json_object('reservoir_id',NEW.id),NEW.created_at
 WHERE EXISTS(SELECT 1 FROM activation_codes ac JOIN devices d ON d.id=ac.device_id
 WHERE d.id=NEW.device_id AND ac.code_hash=d.pairing_code_hash
 AND ac.is_transfer=1 AND ac.used_at IS NULL AND ac.revoked_at IS NULL);
 UPDATE activation_codes SET used_at=NEW.created_at WHERE device_id=NEW.device_id
 AND code_hash=(SELECT pairing_code_hash FROM devices WHERE id=NEW.device_id)
 AND used_at IS NULL AND revoked_at IS NULL;
 UPDATE devices SET owner_user_id=NEW.user_id,pairing_code_hash=NULL,pairing_expires_at=NULL,
 updated_at=NEW.created_at WHERE id=NEW.device_id;
 INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
 VALUES('device_activated',NEW.device_id,NEW.user_id,json_object('reservoir_id',NEW.id),NEW.created_at);
END;
