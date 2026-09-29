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
if (!['devices', 'structure', 'attributes', 'keys', 'latest', 'history'].includes(command)) {
  console.error(
    'Uso: npm run monitorie:probe -- devices|structure [--page 0] | attributes|keys --device-id ID_DA_LISTA | latest|history --device-id ID_DA_LISTA --keys chave1,chave2',
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
    if (command === 'structure') {
      const page = positiveInteger('page', 0, 100000);
      const query = new URLSearchParams({ page: String(page), pageSize: '100', sortProperty: 'name', sortOrder: 'ASC' });
      const response = await fetch(`https://monitorie.com.br/api/user/devices?${query}`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'X-Authorization': `Bearer ${jwt}`, Accept: 'application/json' },
      });
      if (!response.ok || response.status >= 300 || !response.headers.get('Content-Type')?.includes('application/json'))
        throw new Error('Resposta da lista indisponível ou inválida.');
      const raw = await response.json();
      if (!Array.isArray(raw?.data) || raw.data.length > 100) throw new Error('Lista inválida.');
      const macPattern = /^(?:(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2}|[0-9a-f]{12})$/i;
      const macPaths = (value, path = '', depth = 0) => {
        if (typeof value === 'string') return macPattern.test(value) ? [path] : [];
        if (!value || typeof value !== 'object' || depth >= 5) return [];
        return Object.entries(value).flatMap(([key, item]) => macPaths(item, `${path}.${key}`, depth + 1));
      };
      result = raw.data.map((device) => ({
        id: device?.id?.id ?? null,
        fields: Object.keys(device),
        additional_info_fields: device?.additionalInfo && typeof device.additionalInfo === 'object'
          ? Object.keys(device.additionalInfo) : [],
        mac_value_paths: macPaths(device),
      }));
    } else if (command === 'devices') {
      result = await client.devices(positiveInteger('page', 0, 100000), 100);
    } else {
      const deviceId = required('device-id');
      if (command === 'attributes') {
        const attributes = await client.attributes(deviceId);
        result = { keys: attributes.map(({ key }) => key), mac_attributes: attributes
          .filter(({ key }) => ['mac', 'macaddress', 'wifimac', 'wifimacaddress'].includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')))
          .map(({ key, value }) => ({ key, value: typeof value === 'string' && /^(?:(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2}|[0-9a-f]{12})$/i.test(value)
            ? value.toUpperCase() : '[formato não reconhecido]' })) };
      }
      else if (command === 'keys') result = await client.keys(deviceId);
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
