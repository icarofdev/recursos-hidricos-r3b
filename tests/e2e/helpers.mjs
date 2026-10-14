import { localRuntime } from '../../scripts/cloudflare/local-runtime.mjs';
import { randomBytes, createHash } from 'node:crypto';

export async function promoteUserToAdmin(email) {
  const { db, mf } = await localRuntime({ skipDevVars: true });
  try {
    await db
      .prepare(
        "UPDATE users SET email_verified_at=COALESCE(email_verified_at,unixepoch()),role='admin' WHERE lower(email)=lower(?)",
      )
      .bind(email)
      .run();
  } finally {
    await mf.dispose();
  }
}

export async function createPairingCodeForDevice(deviceCode = 'DEV-PAIR-TEST', deviceType = 'SM-WU') {
  const { db, mf } = await localRuntime({ skipDevVars: true });
  try {
    const raw = randomBytes(16).toString('hex').toUpperCase();
    const code = 'HIDRA-' + raw.match(/.{8}/g).join('-');
    const hash = createHash('sha256').update(code).digest('hex');
    const time = Math.floor(Date.now() / 1000);

    const dev = await db
      .prepare(
        `INSERT INTO devices(device_code, device_type, source, pairing_code_hash, pairing_expires_at, created_at, updated_at)
      VALUES (?, ?, 'mock', ?, ?, ?, ?) RETURNING id`,
      )
      .bind(deviceCode, deviceType, hash, time + 86400, time, time)
      .first();

    await db
      .prepare('INSERT INTO activation_codes(device_id,code_hash,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(dev.id, hash, time + 86400, time)
      .run();
    return { deviceId: dev.id, code };
  } finally {
    await mf.dispose();
  }
}

export async function expireAdminMfaForTest(email) {
  const { db, mf } = await localRuntime({ skipDevVars: true });
  try {
    const user = await db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').bind(email).first();
    const time = Math.floor(Date.now() / 1000);
    await db.batch([
      db.prepare('UPDATE sessions SET admin_mfa_at=? WHERE user_id=?').bind(time - 301, user.id),
      db
        .prepare('UPDATE admin_totp SET last_used_step=? WHERE user_id=?')
        .bind(Math.floor(Date.now() / 30000) - 2, user.id),
    ]);
  } finally {
    await mf.dispose();
  }
}
