-- Keep the physical reservoir, owner, readings, activation codes and legacy MACs intact.
CREATE TABLE device_users (
 device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 linked_at INTEGER NOT NULL,
 PRIMARY KEY(device_id,user_id)
);
INSERT INTO device_users(device_id,user_id,linked_at)
 SELECT device_id,user_id,linked_at FROM reservoirs WHERE unlinked_at IS NULL;
CREATE INDEX device_users_user ON device_users(user_id,device_id);
CREATE TRIGGER device_users_limit BEFORE INSERT ON device_users
WHEN NOT EXISTS(SELECT 1 FROM device_users WHERE device_id=NEW.device_id AND user_id=NEW.user_id)
 AND (SELECT COUNT(*) FROM device_users WHERE device_id=NEW.device_id)>=5
BEGIN SELECT RAISE(ABORT,'DEVICE_USER_LIMIT'); END;
CREATE TRIGGER device_users_claim AFTER INSERT ON reservoirs
BEGIN INSERT INTO device_users(device_id,user_id,linked_at) VALUES(NEW.device_id,NEW.user_id,NEW.linked_at); END;
CREATE TRIGGER device_users_release AFTER UPDATE OF unlinked_at ON reservoirs
WHEN OLD.unlinked_at IS NULL AND NEW.unlinked_at IS NOT NULL
BEGIN DELETE FROM device_users WHERE device_id=NEW.device_id; END;
CREATE TRIGGER device_users_erase AFTER DELETE ON reservoirs
WHEN OLD.unlinked_at IS NULL
BEGIN DELETE FROM device_users WHERE device_id=OLD.device_id; END;
ALTER TABLE reservoirs ADD COLUMN installation_type TEXT NOT NULL DEFAULT 'custom'
 CHECK(installation_type IN ('elevated','building','underground','custom'));
ALTER TABLE reservoirs ADD COLUMN geometry TEXT NOT NULL DEFAULT 'reported'
 CHECK(geometry IN ('reported','uniform','horizontal_cylinder','calibration'));
ALTER TABLE reservoirs ADD COLUMN measurement_config TEXT
 CHECK(measurement_config IS NULL OR json_valid(measurement_config));
