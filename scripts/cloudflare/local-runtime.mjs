import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { unstable_splitSqlQuery } from 'wrangler';
import { readDevVars } from './dev-vars.mjs';

export async function localRuntime({ port, ephemeral = false, monitorie = false } = {}) {
  await mkdir('.runtime/local', { recursive: true });
  const file = '.runtime/local/secrets.json';
  if (!ephemeral)
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
  const keys = ephemeral
    ? {
        SESSION_SECRET: randomBytes(32).toString('base64url'),
        PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
      }
    : JSON.parse(await readFile(file, 'utf8'));
  const dev = monitorie ? await readDevVars() : {};
  const monitorieBindings = Object.fromEntries(
    ['MONITORIE_JWT', 'MONITORIE_SMWU_MAPPING', 'MONITORIE_SMWA_MAPPING']
      .filter((name) => monitorie && dev[name])
      .map((name) => [name, dev[name]]),
  );
  if (monitorie && !monitorieBindings.MONITORIE_JWT)
    throw new Error('Configure MONITORIE_JWT em .dev.vars antes de iniciar o modo MonitorIE.');
  const mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/worker/index.js',
    compatibilityDate: '2026-03-01',
    host: '127.0.0.1',
    ...(port ? { port } : {}),
    d1Databases: { DB: 'hidra-local' },
    d1Persist: ephemeral ? false : '.runtime/local/d1',
    log: new Log(LogLevel.ERROR),
    bindings: {
      ...keys,
      APP_ENV: 'development',
      APP_URL: 'http://127.0.0.1:8788',
      CORS_ORIGINS: 'http://127.0.0.1:8788',
      MONITORIE_MODE: monitorie ? 'live' : 'mock',
      ...monitorieBindings,
      MAIL_MODE: 'disabled',
      INGEST_ENABLED: 'true',
    },
    ...(monitorie
      ? {}
      : {
          outboundService: () => {
            throw new Error('Rede externa desativada no ambiente local');
          },
        }),
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
