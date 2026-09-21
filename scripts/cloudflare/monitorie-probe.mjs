import { build } from 'esbuild';
import { readDevVars } from './dev-vars.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
function positiveInteger(name, fallback, maximum) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`--${name} inválido.`);
  return value;
}
function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`Informe --${name}.`);
  return value;
}

const command = process.argv[2];
if (!['devices', 'keys', 'latest', 'history'].includes(command)) {
  console.error(
    'Uso: npm run monitorie:probe -- devices [--page 0] | keys --device-id UUID | latest|history --device-id UUID --keys chave1,chave2',
  );
  process.exitCode = 2;
} else {
  try {
    const variables = await readDevVars();
    const token = process.env.MONITORIE_JWT || variables.MONITORIE_JWT;
    if (!token)
      throw new Error('Configure MONITORIE_JWT em .dev.vars; não informe o token na linha de comando.');
    const compiled = await build({
      entryPoints: ['cloudflare/monitorie/protocol.ts'],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
    });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
    );
    const jwt = module.monitorieJwt({ MONITORIE_MODE: 'live', MONITORIE_JWT: token });
    let reserved = false;
    const gate = {
      async reserve() {
        if (reserved) throw new Error('Cada execução do probe permite somente uma chamada externa.');
        reserved = true;
      },
      async defer() {},
    };
    const client = new module.MonitorieReadClient(async () => jwt, gate);
    let result;
    if (command === 'devices') {
      result = await client.devices(positiveInteger('page', 0, 100000), 100);
    } else {
      const deviceId = required('device-id');
      if (command === 'keys') result = await client.keys(deviceId);
      else {
        const keys = required('keys')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (command === 'latest') result = await client.latest(deviceId, keys);
        else {
          const hours = positiveInteger('hours', 24, 720);
          const limit = positiveInteger('limit', 500, 2000);
          if (hours < 1 || limit < 1) throw new Error('--hours e --limit devem ser maiores que zero.');
          result = await client.history(deviceId, keys, Date.now() - hours * 3600000, Date.now(), limit);
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'MONITORIE_PROBE_FAILED';
    const message = error instanceof Error ? error.message : 'Falha controlada na consulta.';
    console.error(`${code}: ${message}`);
    process.exitCode = 1;
  }
}
