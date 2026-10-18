import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const baseline = process.env.HIDRA_CONSISTENCY_BASELINE === '1';
const baselineCommit = 'eb0b30005a42cf818f8e2a76728f1de1038a141d';
const compiled = await build({
  stdin: {
    contents:
      "export * from './cloudflare/db/reservoirs.ts'; export * from './cloudflare/admin/mutations.ts'; export * from './cloudflare/admin/routes.ts'; export * from './cloudflare/reservoir-volume.ts'; export * from './cloudflare/db/errors.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  plugins: baseline
    ? [
        {
          name: 'read-public-baseline',
          setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
              assert.ok(path.startsWith(resolve('cloudflare')));
              return {
                contents: execFileSync(
                  'git',
                  ['show', baselineCommit + ':' + relative(process.cwd(), path).replaceAll('\\', '/')],
                  { encoding: 'utf8', windowsHide: true },
                ),
                loader: 'ts',
              };
            });
          },
        },
      ]
    : [],
});
const api = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
if (!crypto.subtle.timingSafeEqual)
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const seconds = () => Math.floor(Date.now() / 1000);
const origin = 'https://api.consistency.test';
const app = 'https://app.consistency.test';

async function fixture(run, through = baseline ? 13 : 14) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("synthetic-only")}}',
    d1Databases: { DB: 'consistency-review', RESTORE: 'consistency-restore' },
    d1Persist: false,
    host: '127.0.0.1',
    log: new Log(LogLevel.NONE),
    outboundService: () => {
      throw new Error('No real external service is allowed in this test');
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    const migrations = (await readdir('cloudflare/migrations'))
      .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 4)) <= through)
      .sort();
    for (const file of migrations)
      await db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    await db
      .prepare(
        "INSERT INTO users(id,name,email,password_hash,role,email_verified_at,created_at,updated_at) VALUES(1,'Synthetic owner','owner@example.test','not-a-login-hash','admin',1,?,?)",
      )
      .bind(seconds(), seconds())
      .run();
    const user = await db.prepare('SELECT * FROM users WHERE id=1').first();
    const tasks = [];
    const context = (path, data, database = db) => ({
      request: new Request(origin + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Origin: app,
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'synthetic-csrf',
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      url: new URL(origin + path),
      env: {
        APP_ENV: 'production',
        APP_URL: app,
        CORS_ORIGINS: app,
        SESSION_SECRET: randomBytes(32).toString('base64url'),
        DB: database,
      },
      ctx: { waitUntil: (promise) => tasks.push(promise) },
      user,
      session: { csrf_token: 'synthetic-csrf', read_only: 0, admin_mfa_at: seconds() },
      cookies: [],
      requestId: crypto.randomUUID(),
    });
    const create = async (mac) => {
      const c = context('/api/admin/devices', {
        device_type: 'SM-WU',
        mac_address: mac,
        source: 'local',
      });
      return (await (await api.deviceMutation(c, c.url.pathname)).json()).device;
    };
    await run({ db, context, create, restoredDatabase: () => mf.getD1Database('RESTORE') });
    await Promise.all(tasks);
  } finally {
    await mf.dispose();
  }
}

test('audit identity: deletion/recreation never relabels prior events as the new device', async () => {
  await fixture(async ({ db, context, create }) => {
    const old = await create('02:00:00:00:00:01');
    let c = context(`/api/admin/devices/${old.id}/delete`, { confirmation: true });
    await api.deviceMutation(c, c.url.pathname);
    const replacement = await create('02:00:00:00:00:02');
    assert.notEqual(replacement.id, old.id);
    c = context('/api/admin/audit-logs?limit=100');
    const logs = (await (await api.adminRoute(c, c.url.pathname)).json()).data;
    const deletion = logs.find((entry) => entry.action === 'device_deleted');
    assert.equal(deletion.device.id, old.id);
    assert.ok(deletion.device.identity);
    assert.equal(deletion.device.code, null);
    assert.equal(deletion.device.legacy_identity_unknown, false);
    assert.ok(!logs.some((entry) => entry.action === 'device_deleted' && entry.device.id === replacement.id));
    await assert.rejects(() =>
      db
        .prepare(
          "INSERT INTO devices(id,device_code,device_type,source,created_at,updated_at) VALUES(?,'SYNTHETIC-REUSED','SM-WU','local',1,1)",
        )
        .bind(old.id)
        .run(),
    );
  });
});

const calibration = {
  empty_distance_cm: 100,
  full_distance_cm: 0,
  sensor_min_cm: 0,
  tolerance_cm: 0,
  points: [
    { height_cm: 0, liters: 0 },
    { height_cm: 100, liters: 1000 },
  ],
};

for (const first of ['capacity', 'configuration'])
  test(`configuration version: stale ${first} cannot overwrite a concurrently validated configuration`, async () => {
    await fixture(async ({ db, context, create }) => {
      const device = await create('02:00:00:00:00:10');
      await db
        .prepare(
          "INSERT INTO reservoirs(user_id,device_id,name,linked_at,linked_at_ms,created_at,updated_at) VALUES(1,?,'Synthetic tank',?,?,?,?)",
        )
        .bind(device.id, seconds() - 10, (seconds() - 10) * 1000, seconds(), seconds())
        .run();
      const { id } = await db.prepare('SELECT id FROM reservoirs WHERE device_id=?').bind(device.id).first();
      let unblock, reached;
      const blocked = new Promise((resolve) => (unblock = resolve));
      const ready = new Promise((resolve) => (reached = resolve));
      const paused = {
        prepare: (sql) => db.prepare(sql),
        async batch(statements) {
          reached();
          await blocked;
          return db.batch(statements);
        },
      };
      const payloads = {
        capacity: { reservoir_id: id, capacity_liters: 500 },
        configuration: {
          reservoir_id: id,
          installation_type: 'custom',
          geometry: 'calibration',
          capacity_liters: 1000,
          measurement_config: calibration,
        },
      };
      let c = context('/api/reservoirs/' + first, payloads[first], paused);
      const stale = api.reservoirsRoute(c, c.url.pathname).catch((error) => api.domainError(error));
      const rejection = assert.rejects(stale, (error) => error.status === 409);
      await ready;
      try {
        const other = first === 'capacity' ? 'configuration' : 'capacity';
        c = context('/api/reservoirs/' + other, payloads[other]);
        assert.equal((await api.reservoirsRoute(c, c.url.pathname)).status, 200);
      } finally {
        unblock();
      }
      await rejection;
      const row = await db.prepare('SELECT * FROM reservoirs WHERE id=?').bind(id).first();
      assert.doesNotThrow(() =>
        api.validateConfiguration(row.geometry, row.capacity_liters, JSON.parse(row.measurement_config)),
      );
      assert.equal(row.configuration_version, 1);
    });
  });

test('admin update preserves a communication timestamp advanced after its initial read', async () => {
  await fixture(async ({ db, context, create }) => {
    const device = await create('02:00:00:00:00:20');
    await db
      .prepare("UPDATE devices SET reported_status='offline',last_seen=100 WHERE id=?")
      .bind(device.id)
      .run();
    let unblock, reached;
    const blocked = new Promise((resolve) => (unblock = resolve));
    const ready = new Promise((resolve) => (reached = resolve));
    const paused = {
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        reached();
        await blocked;
        return db.batch(statements);
      },
    };
    const c = context(`/api/admin/devices/${device.id}/update`, { device_type: 'SM-WU' }, paused);
    const pending = api.deviceMutation(c, c.url.pathname);
    await ready;
    try {
      await db
        .prepare(
          "UPDATE devices SET reported_status='online',last_seen=200,communication_checked_at=200 WHERE id=?",
        )
        .bind(device.id)
        .run();
    } finally {
      unblock();
    }
    assert.equal((await pending).status, 200);
    const row = await db
      .prepare('SELECT reported_status,last_seen,communication_checked_at FROM devices WHERE id=?')
      .bind(device.id)
      .first();
    assert.deepEqual(row, { reported_status: 'online', last_seen: 200, communication_checked_at: 200 });
  });
});

test('migration 0014 preserves schema13 data and rolls back an interrupted batch', async () => {
  await fixture(async ({ db, context, create }) => {
    await db
      .prepare(
        "INSERT INTO devices(id,device_code,source,device_type,created_at,updated_at) VALUES(7,'SYNTHETIC-LEGACY','local','SM-WU',1,1)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO reservoirs(user_id,device_id,name,linked_at,created_at,updated_at) VALUES(1,7,'Synthetic legacy tank',1,1,1)",
      )
      .run();
    await db
      .prepare(
        'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(7,1,10,50,500,-60,2)',
      )
      .run();
    await db
      .prepare("INSERT INTO audit_logs(action,device_id,created_at) VALUES('device_deleted',50,1)")
      .run();
    const statements = unstable_splitSqlQuery(
      await readFile('cloudflare/migrations/0014_audit_identity_configuration.sql', 'utf8'),
    );
    await assert.rejects(() =>
      db.batch([
        ...statements.slice(0, 3).map((sql) => db.prepare(sql)),
        db.prepare('INSERT INTO deliberately_missing_table VALUES(1)'),
      ]),
    );
    assert.equal(
      await db.prepare("SELECT 1 FROM sqlite_master WHERE name='device_identities'").first(),
      null,
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
    assert.equal(
      (await db.prepare("SELECT value FROM settings WHERE key='schema_version'").first()).value,
      '14',
    );
    assert.equal(
      (await db.prepare('SELECT device_code FROM devices WHERE id=7').first()).device_code,
      'SYNTHETIC-LEGACY',
    );
    assert.equal((await db.prepare('SELECT volume FROM smwu_readings WHERE id=7').first()).volume, 500);
    assert.equal(
      (await db.prepare('SELECT configuration_version FROM reservoirs WHERE device_id=7').first())
        .configuration_version,
      0,
    );
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM device_identities').first()).n, 2);
    const replacement = await create('02:00:00:00:00:51');
    assert.equal(replacement.id, 51);
    const c = context('/api/admin/audit-logs?device_id=50');
    const legacy = (await (await api.adminRoute(c, c.url.pathname)).json()).data[0];
    assert.equal(legacy.device.identity, null);
    assert.equal(legacy.device.code, null);
    assert.equal(legacy.device.legacy_identity_unknown, true);
    await assert.rejects(() => db.prepare('DELETE FROM device_identities WHERE device_id=50').run());
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  }, 13);
});

test('synthetic schema14 restore preserves device tombstones and passes the existing backup verifier', async () => {
  await fixture(async ({ db, context, create, restoredDatabase }) => {
    const old = await create('02:00:00:00:00:61');
    const deletion = context(`/api/admin/devices/${old.id}/delete`, { confirmation: true });
    await api.deviceMutation(deletion, deletion.url.pathname);
    const next = await create('02:00:00:00:00:62');
    const schema = await db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid",
      )
      .all();
    const tables = schema.results.filter((row) => row.type === 'table');
    const quote = (value) =>
      value === null
        ? 'NULL'
        : typeof value === 'number'
          ? String(value)
          : "'" + String(value).replaceAll("'", "''") + "'";
    let dump = tables.map((table) => table.sql + ';').join('\n') + '\n';
    for (const table of tables) {
      assert.match(table.name, /^[a-z_]+$/);
      const rows = await db.prepare('SELECT * FROM ' + table.name).all();
      for (const row of rows.results)
        dump +=
          'INSERT INTO ' +
          table.name +
          '(' +
          Object.keys(row)
            .map((column) => '"' + column + '"')
            .join(',') +
          ') VALUES(' +
          Object.values(row).map(quote).join(',') +
          ');\n';
    }
    dump += schema.results
      .filter((row) => row.type !== 'table')
      .map((row) => row.sql + ';')
      .join('\n');
    const temporary = await mkdtemp(join(tmpdir(), 'hidra-synthetic-schema14-'));
    const file = join(temporary, 'synthetic.sql');
    try {
      await writeFile(file, dump, 'utf8');
      const result = JSON.parse(
        execFileSync('python', ['scripts/cloudflare/restore-check.py', file], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
      assert.deepEqual(result, {
        integrity: 'ok',
        foreign_key_violations: 0,
        live_database_modified: false,
      });
      const restored = await restoredDatabase();
      await restored.batch(unstable_splitSqlQuery(dump).map((sql) => restored.prepare(sql)));
      const creation = context(
        '/api/admin/devices',
        { device_type: 'SM-WU', source: 'local', mac_address: '02:00:00:00:00:63' },
        restored,
      );
      const device = (await (await api.deviceMutation(creation, creation.url.pathname)).json()).device;
      assert.ok(device.id > next.id);
      assert.notEqual(device.id, old.id);
      assert.equal((await restored.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
    } finally {
      await unlink(file);
      await rmdir(temporary);
    }
  });
});
