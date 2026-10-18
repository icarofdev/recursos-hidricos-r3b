import { localRuntime } from './local-runtime.mjs';
import { randomBytes, createHash } from 'node:crypto';
const { mf, db } = await localRuntime();
try {
  if (process.argv[2] === 'seed') {
    const code = 'HIDRA-' + randomBytes(16).toString('hex').toUpperCase();
    const hash = createHash('sha256').update(code).digest('hex'),
      time = Math.floor(Date.now() / 1000);
    const row = await db
      .prepare(
        `INSERT INTO devices(id,device_code,device_type,source,pairing_code_hash,pairing_expires_at,created_at,updated_at)
   VALUES (COALESCE((SELECT id FROM devices WHERE device_code='DEMO-WU' AND source='mock'),
     (SELECT COALESCE(MAX(device_id),0)+1 FROM device_identities)),
     'DEMO-WU','SM-WU','mock',?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET pairing_code_hash=excluded.pairing_code_hash,pairing_expires_at=excluded.pairing_expires_at
   WHERE owner_user_id IS NULL AND source='mock' AND device_code='DEMO-WU' RETURNING id`,
      )
      .bind(hash, time + 86400, time, time)
      .first();
    if (!row) throw new Error('Demonstração já vinculada. Nenhum vínculo alterado.');
    await db.batch([
      db
        .prepare(
          'UPDATE activation_codes SET revoked_at=? WHERE device_id=? AND used_at IS NULL AND revoked_at IS NULL',
        )
        .bind(time, row.id),
      db
        .prepare('INSERT INTO activation_codes(device_id,code_hash,expires_at,created_at) VALUES(?,?,?,?)')
        .bind(row.id, hash, time + 86400, time),
    ]);
    console.log('Código fictício local (24h): ' + code);
  } else console.log('Migrations locais aplicadas.');
} finally {
  await mf.dispose();
}
