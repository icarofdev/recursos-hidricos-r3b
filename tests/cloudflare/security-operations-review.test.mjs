import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  diagnosticEndpoint,
  diagnosticError,
  diagnosticSummary,
  readDiagnosticJson,
} from '../../scripts/cloudflare/diagnostic-output.mjs';

const baseline = process.env.HIDRA_OPERATIONS_BASELINE_REVISION;
if (baseline && !/^[a-f0-9]{7,40}$/i.test(baseline)) throw new Error('Invalid baseline revision');
const compiled = await build({
  entryPoints: ['cloudflare/db/maintenance.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  ...(baseline
    ? {
        plugins: [
          {
            name: 'baseline-maintenance',
            setup(builder) {
              builder.onLoad({ filter: /maintenance\.ts$/ }, () => ({
                contents: execFileSync('git', ['show', baseline + ':cloudflare/db/maintenance.ts'], {
                  encoding: 'utf8',
                  windowsHide: true,
                }),
                loader: 'ts',
              }));
            },
          },
        ],
      }
    : {}),
});
const { maintenance } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

async function withDatabase(run) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'operations-review' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
    outboundService() {
      throw new Error('External requests are forbidden in operations tests');
    },
  });
  const originalNow = Date.now;
  const clock = {
    time: 1_800_000_000,
    set(time) {
      this.time = time;
    },
  };
  try {
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir('cloudflare/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort())
      await db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + name, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    Date.now = () => clock.time * 1000;
    const env = { DB: db, RETENTION_BATCH_SIZE: '1', RETENTION_MAX_BATCHES: '1' };
    await run({ db, clock, env });
  } finally {
    Date.now = originalNow;
    await mf.dispose();
  }
}

const expiredCounter = (db, key) =>
  db.prepare('INSERT INTO rate_limits(key_hash,attempts,expires_at) VALUES(?,1,1)').bind(key).run();

function pauseBatch(db, matches) {
  let notify,
    resume,
    paused = false;
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  const released = new Promise((resolve) => {
    resume = resolve;
  });
  const wrapped = {
    prepare(sql) {
      const wrap = (statement) => ({
        sql,
        actual: statement,
        bind: (...args) => wrap(statement.bind(...args)),
        first: (...args) => statement.first(...args),
        all: (...args) => statement.all(...args),
        run: () => statement.run(),
      });
      return wrap(db.prepare(sql));
    },
    async batch(statements) {
      if (!paused && statements.some((statement) => matches(statement.sql))) {
        paused = true;
        notify();
        await released;
      }
      return db.batch(statements.map((statement) => statement.actual));
    },
  };
  return { db: wrapped, entered, resume };
}

test('maintenance runs at t, t+60 and t+120 with bounded retention', async () => {
  await withDatabase(async ({ db, clock, env }) => {
    const started = clock.time;
    for (const offset of [0, 60, 120]) {
      clock.set(started + offset);
      await expiredCounter(db, 'expired-' + offset);
      await maintenance({ env });
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM rate_limits').first()).n, 0);
      assert.equal(
        (await db.prepare("SELECT updated_at FROM settings WHERE key='maintenance'").first()).updated_at,
        started + offset,
      );
    }
    assert.equal(await db.prepare("SELECT 1 FROM settings WHERE key='maintenance:lease'").first(), null);
  });
});

test('maintenance blocks a concurrent cycle and fences expired owners before cleanup', async () => {
  await withDatabase(async ({ db, clock, env }) => {
    const paused = pauseBatch(db, (sql) => sql?.startsWith('DELETE FROM smwu_readings'));
    const started = clock.time;
    const predecessor = maintenance({ env: { ...env, DB: paused.db } });
    await paused.entered;
    try {
      clock.set(started + 59);
      await expiredCounter(db, 'active-cycle');
      await maintenance({ env });
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM rate_limits').first()).n, 1);
      clock.set(started + 60);
      await maintenance({ env });
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM rate_limits').first()).n, 0);
      await expiredCounter(db, 'must-survive-stale-owner');
    } finally {
      paused.resume();
      await predecessor;
    }
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM rate_limits').first()).n, 1);
    assert.equal(
      (await db.prepare("SELECT updated_at FROM settings WHERE key='maintenance'").first()).updated_at,
      started + 60,
    );
  });
});

test('a stale maintenance cycle cannot overwrite its successor report', async () => {
  await withDatabase(async ({ db, clock, env }) => {
    const paused = pauseBatch(db, (sql) =>
      sql?.startsWith("UPDATE settings SET value=? WHERE key='maintenance'"),
    );
    const predecessor = maintenance({ env: { ...env, DB: paused.db } });
    await paused.entered;
    let report;
    try {
      clock.set(clock.time + 60);
      await expiredCounter(db, 'successor');
      await maintenance({ env });
      report = await db.prepare("SELECT value,updated_at FROM settings WHERE key='maintenance'").first();
      assert.equal(JSON.parse(report.value).deleted, 1);
    } finally {
      paused.resume();
      await predecessor;
    }
    assert.deepEqual(
      await db.prepare("SELECT value,updated_at FROM settings WHERE key='maintenance'").first(),
      report,
    );
  });
});

test('maintenance releases only its own lease when a cleanup batch fails', async () => {
  await withDatabase(async ({ db, env }) => {
    let batches = 0;
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch(statements) {
        if (++batches === 2) throw new Error('Synthetic D1 failure');
        return db.batch(statements);
      },
    };
    await assert.rejects(maintenance({ env: { ...env, DB: wrapped } }), /Synthetic D1 failure/);
    assert.equal(await db.prepare("SELECT 1 FROM settings WHERE key='maintenance:lease'").first(), null);
  });
});

function countDatabaseWork(db) {
  const counts = { calls: 0, statements: 0, maxParameters: 0, queries: [] };
  const execute = (statement, method, args) => {
    counts.calls++;
    counts.statements++;
    counts.queries.push(statement.sql);
    return statement.actual[method](...args);
  };
  return {
    counts,
    db: {
      prepare(sql) {
        const wrap = (actual) => {
          const statement = {
            sql,
            actual,
            bind(...args) {
              counts.maxParameters = Math.max(counts.maxParameters, args.length);
              return wrap(actual.bind(...args));
            },
            first: (...args) => execute(statement, 'first', args),
            all: (...args) => execute(statement, 'all', args),
            run: (...args) => execute(statement, 'run', args),
          };
          return statement;
        };
        return wrap(db.prepare(sql));
      },
      batch(statements) {
        counts.calls++;
        counts.statements += statements.length;
        counts.queries.push(...statements.map((statement) => statement.sql));
        return db.batch(statements.map((statement) => statement.actual));
      },
    },
  };
}

async function seedRetentionBacklog(db, past) {
  await db
    .prepare(
      "INSERT INTO users(id,name,email,password_hash,created_at,updated_at) VALUES(1,'Synthetic User','retention@example.test','synthetic-password-hash',1,1)",
    )
    .run();
  for (let i = 1; i <= 3; i++) {
    await db
      .prepare("INSERT INTO devices(id,device_code,source,created_at,updated_at) VALUES(?,?,'local',1,1)")
      .bind(i, 'synthetic-device-' + i)
      .run();
    await db.batch([
      db
        .prepare(
          'INSERT INTO smwu_readings(id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(1,1,1,1,-50,?)',
        )
        .bind(past),
      db
        .prepare(
          'INSERT INTO smwa_readings(id,vazao,consumo_acumulado,rssi_wifi,created_at) VALUES(1,1,1,-50,?)',
        )
        .bind(past),
      db.prepare("INSERT INTO audit_logs(action,created_at) VALUES('synthetic_retention',?)").bind(past),
      db
        .prepare(
          "INSERT INTO security_events(event_type,result,request_id,created_at) VALUES('synthetic_retention','failure',?,?)",
        )
        .bind('request-' + i, past),
      db
        .prepare(
          "INSERT INTO endpoint_requests(window_start,path,method,country,request_count,last_status,last_request_id,updated_at) VALUES(?,?,'GET','XX',1,200,?,?)",
        )
        .bind(past, '/synthetic/' + i, 'request-' + i, past),
      db
        .prepare('INSERT INTO telemetry_cache(cache_key,expires_at) VALUES(?,?)')
        .bind('expired-cache-' + i, past),
      db
        .prepare(
          "INSERT INTO sessions(token_hash,csrf_token,created_at,last_seen,rotated_at,expires_at) VALUES(?,'synthetic-csrf',?,?,?,?)",
        )
        .bind('expired-session-' + i, past, past, past, past),
      db
        .prepare('INSERT INTO rate_limits(key_hash,attempts,expires_at) VALUES(?,1,?)')
        .bind('expired-counter-' + i, past),
      db
        .prepare(
          'INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,1,?,?)',
        )
        .bind('expired-reset-' + i, past, past),
      db
        .prepare(
          'INSERT INTO email_verification_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,1,?,?)',
        )
        .bind('expired-proof-' + i, past, past),
      db
        .prepare(
          "INSERT INTO admin_totp_challenges(challenge_hash,user_id,session_hash,session_version,stage,remember,next_path,expires_at,created_at) VALUES(?,1,'synthetic-session',1,'setup',0,'/',?,?)",
        )
        .bind('expired-challenge-' + i, past, past),
      db
        .prepare(
          'INSERT INTO activation_codes(device_id,code_hash,expires_at,revoked_at,created_at) VALUES(1,?,?,?,?)',
        )
        .bind('expired-activation-' + i, past, past, past),
      db
        .prepare('INSERT INTO admin_totp_recovery(code_hash,user_id,used_at,created_at) VALUES(?,1,?,?)')
        .bind('expired-recovery-' + i, past, past),
      db
        .prepare('INSERT INTO monitorie_queue(device_id,requested_at,expires_at) VALUES(?,?,?)')
        .bind(i, past, past),
      db
        .prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)')
        .bind('monitorie:discovery:expired-' + i, '{}', past),
    ]);
  }
}

test('maintenance bounds statements and preserves every backlog category with two or three requested rounds', async () => {
  const categories = [
    'smwu_readings',
    'smwa_readings',
    'audit_logs',
    'security_events',
    'endpoint_requests',
    'telemetry_cache',
    'sessions',
    'rate_limits',
    'password_reset_tokens',
    'email_verification_tokens',
    'admin_totp_challenges',
    'activation_codes',
    'admin_totp_recovery',
    'monitorie_queue',
    'monitorie_discoveries',
  ];
  for (const requested of ['2', '3']) {
    await withDatabase(async ({ db, clock, env }) => {
      await seedRetentionBacklog(db, clock.time - 400 * 86400);
      const measured = countDatabaseWork(db);
      await maintenance({ env: { ...env, DB: measured.db, RETENTION_MAX_BATCHES: requested } });
      const report = JSON.parse(
        (await db.prepare("SELECT value FROM settings WHERE key='maintenance'").first()).value,
      );
      assert.equal(report.deleted, 28, 'Two rounds preserve the one-row per table batch bound');
      assert.equal(report.backlog, true);
      assert.deepEqual(report.tables.sort(), categories.toSorted());
      for (const table of categories.filter((table) => table !== 'monitorie_discoveries'))
        assert.equal((await db.prepare('SELECT COUNT(*) n FROM ' + table).first()).n, 1, table);
      assert.equal(
        (await db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'monitorie:discovery:%'").first())
          .n,
        2,
      );
      assert.equal(measured.counts.calls, 8);
      assert.equal(measured.counts.statements, 40);
      assert.ok(measured.counts.statements <= 50);
      assert.equal(measured.counts.maxParameters, 18);
      assert.ok(measured.counts.maxParameters <= 100);
      const backlogQueries = measured.counts.queries.filter((sql) => sql.startsWith('SELECT EXISTS('));
      assert.equal(backlogQueries.length, 1);
      assert.equal(backlogQueries[0].match(/EXISTS\(SELECT 1 FROM /g).length, categories.length);
    });
  }
});

test('diagnostic defaults redact device identities, telemetry values and error messages', () => {
  const privateValue = 'private-value-never-log';
  const summaries = [
    diagnosticSummary('devices', {
      data: [{ id: privateValue, name: privateValue }],
      page: 0,
      totalPages: 1,
      totalElements: 1,
      hasNext: false,
    }),
    diagnosticSummary('structure', [
      { id: privateValue, fields: [privateValue], mac_value_paths: [privateValue] },
    ]),
    diagnosticSummary('attributes', {
      keys: [privateValue],
      mac_attributes: [{ key: privateValue, value: privateValue }],
    }),
    diagnosticSummary('keys', [privateValue]),
    diagnosticSummary('latest', { [privateValue]: [{ ts: 123, value: privateValue }] }),
    diagnosticSummary('history', {
      series: { [privateValue]: [{ ts: 123, value: privateValue }] },
      possiblyTruncated: true,
    }),
    diagnosticError({ code: privateValue, message: privateValue }),
    diagnosticEndpoint('/api/plugins/telemetry/DEVICE/' + privateValue + '/values/timeseries'),
  ];
  assert.doesNotMatch(JSON.stringify(summaries), /private-value-never-log/);
  assert.deepEqual(summaries[5], { series: 1, points: 1, possiblyTruncated: true });
  assert.equal(diagnosticError({ code: 'MONITORIE_TIMEOUT', message: privateValue }), 'MONITORIE_TIMEOUT');
});

async function syntheticDiagnostic(filename, args = [], fail = false, responseBody) {
  const file = 'scripts/cloudflare/' + filename;
  const source = baseline
    ? execFileSync('git', ['show', baseline + ':' + file], { encoding: 'utf8', windowsHide: true })
    : await readFile(file, 'utf8');
  const privateValue = 'private-value-never-log';
  // Run the actual CLI body with synthetic imports. No dev-vars module, secret
  // input, local persistent runtime or network transport is ever imported.
  const syntheticModule = `
    export class MonitorieAuth {}
    export class D1MonitorieGate {}
    export const monitorieJwt = () => 'synthetic.jwt.value';
    export class MonitorieReadClient {
      async devices() {
        if (${fail}) throw new Error('${privateValue}');
        return {data:[{id:'${privateValue}',name:'${privateValue}',type:'${privateValue}'}],page:0,totalPages:1,totalElements:1,hasNext:false};
      }
      async latest() {return {'${privateValue}':[{ts:1800000000000,value:'${privateValue}'}]};}
    }
  `;
  const output = [];
  const mockProcess = {
    argv: ['node', file, ...args],
    env: {},
    exitCode: 0,
    exit() {
      throw new Error('Unexpected exit in synthetic diagnostic');
    },
  };
  const dependencies = {
    build: async () => ({ outputFiles: [{ text: syntheticModule }] }),
    readDevVars: async () => ({
      MONITORIE_USERNAME: 'synthetic-user',
      MONITORIE_PASSWORD: 'synthetic-password',
      MONITORIE_JWT: 'synthetic.jwt.value',
    }),
    localRuntime: async () => ({
      mf: { dispose: async () => {} },
      db: { prepare: () => ({ run: async () => {}, first: async () => ({ value: '0' }) }) },
    }),
    randomBytes: (length) => Buffer.alloc(length, 1),
    diagnosticEndpoint,
    diagnosticError,
    diagnosticSummary,
    readDiagnosticJson,
    process: mockProcess,
    console: {
      log: (...values) => output.push(values.join(' ')),
      error: (...values) => output.push(values.join(' ')),
    },
    fetch: async () => {
      if (responseBody !== undefined)
        return new Response(responseBody, { headers: { 'Content-Type': 'application/json' } });
      throw new Error('External requests are forbidden in operations tests');
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(dependencies), source.replace(/^import\s[\s\S]*?;\r?\n/gm, ''))(
    ...Object.values(dependencies),
  );
  return output.join('\n');
}

test('diagnostic scripts redact actual CLI output with only synthetic imports', async () => {
  const latest = ['latest', '--device-id', 'synthetic-id', '--keys', 'synthetic-key'];
  const output = [
    await syntheticDiagnostic('monitorie-probe.mjs', ['devices']),
    await syntheticDiagnostic('monitorie-probe.mjs', latest),
    await syntheticDiagnostic('monitorie-probe.mjs', ['devices'], true),
    await syntheticDiagnostic('monitorie-auth-live.mjs'),
    await syntheticDiagnostic('monitorie-auth-live.mjs', [], true),
  ];
  assert.doesNotMatch(output.join('\n'), /private-value-never-log/);
  assert.match(
    await syntheticDiagnostic('monitorie-probe.mjs', [...latest, '--include-sensitive']),
    /private-value-never-log/,
  );
});

test('structure diagnostic bounds streamed JSON and rejects malformed UTF-8', async () => {
  assert.deepEqual(await readDiagnosticJson(new Response('{"data":[]}')), { data: [] });
  await assert.rejects(
    readDiagnosticJson(new Response(' '.repeat(1024 * 1024 + 1))),
    /MONITORIE_INVALID_DATA/,
  );
  await assert.rejects(
    readDiagnosticJson(new Response('{}', { headers: { 'Content-Length': '1048577' } })),
    /MONITORIE_INVALID_DATA/,
  );
  await assert.rejects(readDiagnosticJson(new Response(Uint8Array.of(0xff))), /encoded data/i);
});

test('structure CLI rejects an oversized provider body before parsing it', async () => {
  const response = JSON.stringify({ data: [{ id: { id: 'synthetic-id' }, extra: 'x'.repeat(1024 * 1024) }] });
  const output = await syntheticDiagnostic('monitorie-probe.mjs', ['structure'], false, response);
  assert.match(output, /MONITORIE_PROBE_FAILED/);
  assert.doesNotMatch(output, /synthetic-id/);
});

test('diagnostic entry points use summaries by default and never print raw errors', async () => {
  const probe = await readFile('scripts/cloudflare/monitorie-probe.mjs', 'utf8');
  const live = await readFile('scripts/cloudflare/monitorie-auth-live.mjs', 'utf8');
  assert.match(
    probe,
    /process\.argv\.includes\('--include-sensitive'\) \? result : diagnosticSummary\(command, result\)/,
  );
  assert.match(probe, /await readDiagnosticJson\(response\)/);
  assert.match(live, /diagnosticSummary\('latest', series\)/);
  assert.match(live, /diagnosticEndpoint\(path\)/);
  assert.doesNotMatch(probe + live, /console\.(?:log|error)\([^;]*(?:error\.message|error\?\.message)/);
  assert.doesNotMatch(live, /device: \{ name: selected\.name/);
});

test('secret upload delegates to portable Node and Wrangler without platform-specific paths', async () => {
  const script = await readFile('scripts/cloudflare/put-secret.mjs', 'utf8');
  const wrapper = await readFile('scripts/cloudflare/wrangler.mjs', 'utf8');
  assert.match(
    script,
    /spawn\(process\.execPath, \['scripts\/cloudflare\/wrangler\.mjs', 'secret', 'put', name\]/,
  );
  assert.match(
    wrapper,
    /fileURLToPath\(new URL\('\.\.\/\.\.\/node_modules\/wrangler\/bin\/wrangler\.js', import\.meta\.url\)\)/,
  );
  assert.doesNotMatch(script + wrapper, /[A-Z]:\\|node\.exe|cmd(?:\.exe)?\s+\/c/);
  assert.match(script, /child\.stdout\.resume\(\)/);
  assert.match(script, /child\.stderr\.resume\(\)/);
});

test('CI grants read-only contents, pins official actions, and discards checkout credentials', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /^permissions:\r?\n {2}contents: read\r?$/m);
  assert.match(workflow, /persist-credentials: false/);
  const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
  assert.equal(actions.length, 2);
  for (const action of actions) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|workflow_run|secrets\.|permissions:\s*write-all|id-token:\s*write/,
  );
});

test('operations documentation names migrations that exist in the checkout', async () => {
  const doc = await readFile('docs/OPERATIONS.md', 'utf8');
  const files = new Set(await readdir('cloudflare/migrations'));
  for (const [, migration] of doc.matchAll(/\*\*(\d{4}_[a-z_]+\.sql)\*\*/g))
    assert.ok(files.has(migration), migration + ' must exist');
});
