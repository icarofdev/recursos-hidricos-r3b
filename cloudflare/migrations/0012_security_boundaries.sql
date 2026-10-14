-- Never attest existing e-mail addresses automatically. Existing admin login is preserved.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
CREATE TABLE email_verification_tokens (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX email_verification_expiry ON email_verification_tokens(expires_at);
CREATE TRIGGER email_verification_consumed AFTER UPDATE OF email_verified_at ON users
WHEN NEW.email_verified_at IS NOT NULL AND OLD.email_verified_at IS NULL
BEGIN UPDATE email_verification_tokens SET used_at=NEW.email_verified_at WHERE user_id=NEW.id AND used_at IS NULL; END;
CREATE TRIGGER email_change_revokes_proof AFTER UPDATE OF email ON users
WHEN lower(trim(NEW.email))<>lower(trim(OLD.email)) BEGIN
 UPDATE users SET email_verified_at=NULL,session_version=session_version+1 WHERE id=NEW.id;
 DELETE FROM email_verification_tokens WHERE user_id=NEW.id;
 DELETE FROM sessions WHERE user_id=NEW.id;
 DELETE FROM admin_totp_challenges WHERE user_id=NEW.id;
END;
ALTER TABLE sessions ADD COLUMN share_version TEXT;
ALTER TABLE sessions ADD COLUMN pending_hash TEXT;
ALTER TABLE sessions ADD COLUMN pending_until INTEGER;
CREATE UNIQUE INDEX sessions_pending ON sessions(pending_hash) WHERE pending_hash IS NOT NULL;
-- Old shared sessions cannot be assigned to the new configuration retroactively.
DELETE FROM sessions WHERE read_only=1;
ALTER TABLE devices ADD COLUMN ownership_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN first_claim_at INTEGER;
ALTER TABLE devices ADD COLUMN communication_checked_at INTEGER;
UPDATE devices SET first_claim_at=(SELECT MIN(linked_at) FROM reservoirs WHERE device_id=devices.id),
 ownership_generation=(SELECT COUNT(*) FROM reservoirs WHERE device_id=devices.id);
-- Audit survives erasure; mark unknown historical ownership conservatively.
UPDATE devices SET ownership_generation=MAX(ownership_generation,1),first_claim_at=COALESCE(first_claim_at,created_at)
 WHERE EXISTS(SELECT 1 FROM audit_logs WHERE device_id=devices.id AND action IN ('device_activated','transfer_completed'));
UPDATE devices SET ownership_generation=MAX(ownership_generation,1) WHERE source='monitorie' AND external_id IS NOT NULL;
CREATE TABLE monitorie_queue(device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
ALTER TABLE device_users ADD COLUMN access_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE device_users ADD COLUMN access_started_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservoirs ADD COLUMN linked_at_ms INTEGER NOT NULL DEFAULT 0;
UPDATE reservoirs SET linked_at_ms=linked_at*1000;
UPDATE device_users SET access_started_ms=linked_at*1000;
UPDATE device_users SET access_generation=lower(hex(randomblob(16)));
ALTER TABLE device_credentials ADD COLUMN ownership_generation INTEGER NOT NULL DEFAULT 0;
UPDATE device_credentials SET ownership_generation=(SELECT ownership_generation FROM devices WHERE id=device_id);
ALTER TABLE telemetry_cache ADD COLUMN device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE telemetry_cache ADD COLUMN access_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE telemetry_cache ADD COLUMN fetched_at INTEGER NOT NULL DEFAULT 0;
DELETE FROM telemetry_cache;
DROP TRIGGER reservoir_claim;
DROP TRIGGER device_users_claim;
CREATE TABLE activation_codes_new (
 id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL UNIQUE,
 created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER,
 revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
 is_transfer INTEGER NOT NULL DEFAULT 0 CHECK(is_transfer IN (0,1))
);
INSERT INTO activation_codes_new SELECT * FROM activation_codes;
DROP TABLE activation_codes;
ALTER TABLE activation_codes_new RENAME TO activation_codes;
CREATE INDEX idx_activation_device ON activation_codes(device_id,used_at,revoked_at);
CREATE INDEX activation_expiry ON activation_codes(expires_at);
CREATE UNIQUE INDEX activation_one_active ON activation_codes(device_id) WHERE used_at IS NULL AND revoked_at IS NULL;
-- Hashes with no authoritative live record are rejected, rather than legitimized.
UPDATE activation_codes SET revoked_at=unixepoch() WHERE used_at IS NULL AND revoked_at IS NULL
 AND (expires_at<=unixepoch() OR NOT EXISTS(SELECT 1 FROM devices WHERE id=device_id AND pairing_code_hash=code_hash AND owner_user_id IS NULL));
UPDATE devices SET pairing_code_hash=NULL,pairing_expires_at=NULL WHERE pairing_code_hash IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM activation_codes WHERE device_id=devices.id AND code_hash=devices.pairing_code_hash
 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>unixepoch());
CREATE TRIGGER activation_issuer_erase BEFORE DELETE ON users BEGIN
 UPDATE devices SET pairing_code_hash=NULL,pairing_expires_at=NULL WHERE pairing_code_hash IN
 (SELECT code_hash FROM activation_codes WHERE created_by_user_id=OLD.id AND used_at IS NULL AND revoked_at IS NULL);
 UPDATE activation_codes SET revoked_at=unixepoch() WHERE created_by_user_id=OLD.id AND used_at IS NULL AND revoked_at IS NULL;
END;
CREATE TRIGGER reservoir_claim AFTER INSERT ON reservoirs BEGIN
 INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
 SELECT 'transfer_completed',NEW.device_id,NEW.user_id,json_object('reservoir_id',NEW.id),NEW.created_at
 WHERE EXISTS(SELECT 1 FROM activation_codes ac JOIN devices d ON d.id=ac.device_id WHERE d.id=NEW.device_id
 AND ac.code_hash=d.pairing_code_hash AND ac.is_transfer=1 AND ac.used_at IS NULL AND ac.revoked_at IS NULL);
 UPDATE activation_codes SET used_at=NEW.created_at WHERE device_id=NEW.device_id
 AND code_hash=(SELECT pairing_code_hash FROM devices WHERE id=NEW.device_id) AND used_at IS NULL AND revoked_at IS NULL;
 UPDATE devices SET owner_user_id=NEW.user_id,pairing_code_hash=NULL,pairing_expires_at=NULL,
 ownership_generation=ownership_generation+1,first_claim_at=COALESCE(first_claim_at,NEW.linked_at),
 reported_status='offline',last_seen=NULL,updated_at=NEW.created_at WHERE id=NEW.device_id;
 UPDATE device_credentials SET revoked_at=NEW.created_at,updated_at=NEW.created_at WHERE device_id=NEW.device_id;
 DELETE FROM telemetry_cache WHERE device_id=NEW.device_id;
 INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
 VALUES('device_activated',NEW.device_id,NEW.user_id,json_object('reservoir_id',NEW.id),NEW.created_at);
END;
CREATE TRIGGER device_users_claim AFTER INSERT ON reservoirs BEGIN
 INSERT INTO device_users(device_id,user_id,linked_at,access_generation,access_started_ms) VALUES(NEW.device_id,NEW.user_id,NEW.linked_at,lower(hex(randomblob(16))),CASE WHEN NEW.linked_at_ms>0 THEN NEW.linked_at_ms ELSE NEW.linked_at*1000 END);
END;
CREATE TRIGGER device_access_cache_remove AFTER DELETE ON device_users BEGIN
 DELETE FROM telemetry_cache WHERE device_id=OLD.device_id AND access_user_id=OLD.user_id;
END;
CREATE TRIGGER device_release_credentials AFTER UPDATE OF unlinked_at ON reservoirs
WHEN OLD.unlinked_at IS NULL AND NEW.unlinked_at IS NOT NULL BEGIN
 UPDATE device_credentials SET revoked_at=NEW.updated_at,updated_at=NEW.updated_at WHERE device_id=NEW.device_id;
 DELETE FROM telemetry_cache WHERE device_id=NEW.device_id;
 UPDATE devices SET reported_status='offline',last_seen=NULL WHERE id=NEW.device_id;
END;
CREATE TRIGGER account_operational_erase BEFORE DELETE ON users BEGIN
 DELETE FROM security_events WHERE account_id=OLD.id;
 DELETE FROM telemetry_cache WHERE access_user_id=OLD.id OR device_id IN(SELECT id FROM devices WHERE owner_user_id=OLD.id);
 DELETE FROM settings WHERE key IN(SELECT 'monitorie:discovery:'||id FROM devices WHERE owner_user_id=OLD.id);
END;
CREATE TRIGGER device_operational_erase BEFORE DELETE ON devices BEGIN
 DELETE FROM settings WHERE key='monitorie:discovery:'||OLD.id;
END;
CREATE TRIGGER verify_admin_promotion BEFORE UPDATE OF role ON users
WHEN NEW.role='admin' AND OLD.role<>'admin' AND NEW.email_verified_at IS NULL
BEGIN SELECT RAISE(ABORT,'EMAIL_VERIFICATION_REQUIRED'); END;
-- Cleanup predicates stay indexed even when no expired rows are found.
CREATE INDEX activation_used_retention ON activation_codes(used_at);
CREATE INDEX activation_revoked_retention ON activation_codes(revoked_at);
CREATE INDEX recovery_used_retention ON admin_totp_recovery(used_at);
CREATE INDEX challenges_consumed_retention ON admin_totp_challenges(consumed_at);
CREATE INDEX settings_age ON settings(updated_at,key);
CREATE INDEX cache_cleanup_age ON telemetry_cache(MAX(expires_at,lease_until,negative_until));
CREATE INDEX sessions_idle_retention ON sessions(last_seen+CASE WHEN user_id IS NULL THEN 3600 WHEN remember=1 THEN 2592000 ELSE 7200 END);
