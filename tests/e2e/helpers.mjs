import { localRuntime } from '../../scripts/cloudflare/local-runtime.mjs';
import { randomBytes, createHash } from 'node:crypto';

export async function promoteUserToAdmin(email) {
  const { db, mf } = await localRuntime();
  try {
    await db.prepare("UPDATE users SET role='admin' WHERE lower(email)=lower(?)").bind(email).run();
  } finally {
    await mf.dispose();
  }
}

export async function createPairingCodeForDevice(deviceCode = 'DEV-PAIR-TEST', deviceType = 'SM-WU') {
  const { db, mf } = await localRuntime();
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

    return { deviceId: dev.id, code };
  } finally {
    await mf.dispose();
  }
}
