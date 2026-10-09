ALTER TABLE sessions ADD COLUMN admin_mfa_at INTEGER;

CREATE TABLE admin_totp (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_encrypted TEXT NOT NULL,
 last_used_step INTEGER NOT NULL DEFAULT -1,
 created_at INTEGER NOT NULL
);

CREATE TABLE admin_totp_challenges (
 challenge_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL,
 session_version INTEGER NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('setup','verify','recovery_setup')),
 pending_secret_encrypted TEXT,
 remember INTEGER NOT NULL CHECK(remember IN (0,1)),
 next_path TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX admin_totp_challenges_user ON admin_totp_challenges(user_id, expires_at);
CREATE INDEX admin_totp_challenges_expiry ON admin_totp_challenges(expires_at);

CREATE TABLE admin_totp_recovery (
 code_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 used_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX admin_totp_recovery_user ON admin_totp_recovery(user_id, used_at);

CREATE TRIGGER revoke_totp_challenges_on_password_change AFTER UPDATE OF password_hash ON users
WHEN NEW.password_hash <> OLD.password_hash
BEGIN
 DELETE FROM admin_totp_challenges WHERE user_id=NEW.id;
END;

CREATE TRIGGER revoke_totp_sessions_on_role_change AFTER UPDATE OF role ON users
WHEN NEW.role <> OLD.role
BEGIN
 UPDATE sessions SET admin_mfa_at=NULL WHERE user_id=NEW.id;
 DELETE FROM admin_totp_challenges WHERE user_id=NEW.id;
END;
