import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { unstable_splitSqlQuery } from 'wrangler';
import { readDevVars } from './dev-vars.mjs';

export async function localRuntime({ port, ephemeral = false, monitorie = false, skipDevVars = false } = {}) {
  const e2e = process.env.HIDRA_E2E_NO_DEV_VARS === '1';
  const runId = process.env.HIDRA_E2E_RUN_ID;
  if (e2e && !/^[a-f0-9]{24}$/.test(runId ?? '')) throw new Error('Identificador E2E inválido');
  const runtimeRoot = e2e ? `.runtime/e2e/${runId}` : '.runtime/local';
  const appUrl =
    process.env.HIDRA_E2E_NO_DEV_VARS === '1' ? 'http://127.0.0.1:18888' : 'http://127.0.0.1:8788';
  await mkdir(runtimeRoot, { recursive: true });
  const file = `${runtimeRoot}/secrets.json`;
  if (!ephemeral && !e2e)
    try {
      await writeFile(
        file,
        JSON.stringify({
          SESSION_SECRET: randomBytes(32).toString('base64url'),
          PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  const keys =
    ephemeral || e2e
      ? {
          SESSION_SECRET: randomBytes(32).toString('base64url'),
          PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
        }
      : JSON.parse(await readFile(file, 'utf8'));
  const dev = skipDevVars || process.env.HIDRA_E2E_NO_DEV_VARS === '1' ? {} : await readDevVars();
  const monitorieBindings = Object.fromEntries(
    [
      'MONITORIE_JWT',
      'MONITORIE_USERNAME',
      'MONITORIE_PASSWORD',
      'MONITORIE_SMWU_MAPPING',
      'MONITORIE_SMWA_MAPPING',
    ]
      .filter((name) => monitorie && dev[name])
      .map((name) => [name, dev[name]]),
  );
  if (
    monitorie &&
    !monitorieBindings.MONITORIE_JWT &&
    !(monitorieBindings.MONITORIE_USERNAME && monitorieBindings.MONITORIE_PASSWORD)
  )
    throw new Error('Configure MONITORIE_USERNAME/MONITORIE_PASSWORD ou MONITORIE_JWT em .dev.vars.');
  const mailEnabled = dev.MAIL_MODE === 'resend';
  const mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/worker/index.js',
    compatibilityDate: '2026-03-01',
    host: '127.0.0.1',
    ...(port ? { port } : {}),
    d1Databases: { DB: 'hidra-local' },
    d1Persist: ephemeral ? false : `${runtimeRoot}/d1`,
    log: new Log(LogLevel.ERROR),
    bindings: {
      ...keys,
      APP_ENV: 'development',
      APP_URL: appUrl,
      CORS_ORIGINS: appUrl,
      MONITORIE_MODE: monitorie ? 'live' : 'mock',
      ...monitorieBindings,
      MAIL_MODE: mailEnabled ? 'resend' : 'disabled',
      RESEND_API_KEY: mailEnabled ? (dev.RESEND_API_KEY ?? '') : '',
      EMAIL_FROM: mailEnabled ? (dev.EMAIL_FROM ?? '') : '',
      TOTP_ENCRYPTION_KEY: dev.TOTP_ENCRYPTION_KEY || process.env.TOTP_ENCRYPTION_KEY || '',
      INGEST_ENABLED: 'true',
    },
    outboundService: async (request) => {
      const target = new URL(request.url);
      const resend =
        mailEnabled &&
        target.origin === 'https://api.resend.com' &&
        target.pathname === '/emails' &&
        request.method === 'POST';
      const monitorieAuthPost =
        request.method === 'POST' && ['/api/auth/login', '/api/auth/token'].includes(target.pathname);
      const monitorieRequest =
        monitorie &&
        target.origin === 'https://monitorie.com.br' &&
        (request.method === 'GET' || monitorieAuthPost);
      if (!resend && !monitorieRequest) throw new Error('Destino externo não permitido no ambiente local');
      return fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'POST' ? { body: request.body, duplex: 'half' } : {}),
        redirect: 'manual',
      });
    },
  });
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  for (const name of (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    if (await db.prepare('SELECT 1 FROM local_migrations WHERE name=?').bind(name).first()) continue;
    const sql = unstable_splitSqlQuery(await readFile(`cloudflare/migrations/${name}`, 'utf8'));
    await db.batch([
      ...sql.map((q) => db.prepare(q)),
      db.prepare('INSERT INTO local_migrations(name) VALUES (?)').bind(name),
    ]);
  }
  return { mf, db };
}
