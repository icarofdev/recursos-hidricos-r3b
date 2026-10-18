import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { readDevVars } from './dev-vars.mjs';
import { localRuntime } from './local-runtime.mjs';
import { diagnosticEndpoint, diagnosticError, diagnosticSummary } from './diagnostic-output.mjs';

async function load(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const variables = await readDevVars();
if (!variables.MONITORIE_USERNAME || !variables.MONITORIE_PASSWORD) {
  console.error('Preencha MONITORIE_USERNAME e MONITORIE_PASSWORD em .dev.vars.');
  process.exit(2);
}

let runtime;
const events = [];
const transportErrors = [];
try {
  const { mf, db } = await localRuntime({ ephemeral: true });
  runtime = mf;
  const [{ MonitorieAuth }, { MonitorieReadClient, D1MonitorieGate }] = await Promise.all([
    load('cloudflare/monitorie/auth.ts'),
    load('cloudflare/monitorie/protocol.ts'),
  ]);
  const transport = async (request) => {
    const path = new URL(request.url).pathname;
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      transportErrors.push({
        path,
        name: error?.name,
        code: error?.cause?.code,
      });
      throw error;
    }
    events.push({ method: request.method, path, status: response.status, startedAt });
    return response;
  };
  const auth = new MonitorieAuth(
    {
      DB: db,
      MONITORIE_MODE: 'live',
      MONITORIE_USERNAME: variables.MONITORIE_USERNAME,
      MONITORIE_PASSWORD: variables.MONITORIE_PASSWORD,
      SESSION_SECRET: randomBytes(32).toString('base64url'),
    },
    transport,
  );
  const client = new MonitorieReadClient(auth, new D1MonitorieGate(db), transport);
  const devices = await client.devices();
  if (!devices.data.length) throw new Error('MONITORIE_NO_DEVICES');
  const selected =
    devices.data.find((device) => /SM-WU/i.test(`${device.name} ${device.label ?? ''} ${device.type}`)) ??
    devices.data[0];

  // Antecipar a renovação somente neste D1 efêmero para testar o endpoint real de refresh.
  await db.prepare('UPDATE monitorie_auth_cache SET force_refresh=1 WHERE id=1').run();
  const gate = await db.prepare("SELECT value FROM settings WHERE key='monitorie:next-request-ms'").first();
  const delay = Math.max(0, Number(gate?.value || 0) - Date.now() + 2_000);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

  const series = await client.latest(selected.id, ['mac', 'd', 'nivel', 'volume', 'rssi_wifi']);
  const authentication = events
    .filter((event) => event.method === 'POST')
    .map(({ path, status }) => ({ path, status }));
  const gets = events.filter((event) => event.method === 'GET');
  console.log(
    JSON.stringify(
      {
        authentication,
        provider_gets: gets.map(({ path, status }) => ({ endpoint: diagnosticEndpoint(path), status })),
        interval_ms: gets[1]?.startedAt - gets[0]?.startedAt,
        device_selected: true,
        readings: diagnosticSummary('latest', series),
      },
      null,
      2,
    ),
  );
  if (
    authentication.length !== 2 ||
    authentication[0].path !== '/api/auth/login' ||
    authentication[0].status < 200 ||
    authentication[0].status >= 300 ||
    authentication[1].path !== '/api/auth/token' ||
    authentication[1].status < 200 ||
    authentication[1].status >= 300 ||
    gets.length !== 2 ||
    gets[1].startedAt - gets[0].startedAt < 60_000
  )
    process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      error: diagnosticError(error, 'MONITORIE_LIVE_PROBE_FAILED'),
      authentication: events
        .filter((event) => event.method === 'POST')
        .map(({ path, status }) => ({ endpoint: diagnosticEndpoint(path), status })),
      transport_errors: transportErrors.length,
    }),
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
