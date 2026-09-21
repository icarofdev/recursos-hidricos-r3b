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
   VALUES (1,'DEMO-WU','SM-WU','mock',?,?,?,?) ON CONFLICT(id) DO UPDATE SET pairing_code_hash=excluded.pairing_code_hash,pairing_expires_at=excluded.pairing_expires_at
   WHERE owner_user_id IS NULL AND source='mock' RETURNING id`,
      )
      .bind(hash, time + 86400, time, time)
      .first();
    if (!row) throw new Error('Demonstração já vinculada. Nenhum vínculo alterado.');
    console.log('Código fictício local (24h): ' + code);
  } else console.log('Migrations locais aplicadas.');
} finally {
  await mf.dispose();
}
