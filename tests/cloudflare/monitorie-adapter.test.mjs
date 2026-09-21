import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['cloudflare/monitorie/adapter.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const { MonitorieAPI } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
const id = '00000000-0000-4000-8000-000000000001';
const code = (expected) => (error) => error.code === expected && !error.message.includes('FAKE_SECRET');
const scope = (type) => ({
  deviceId: 7,
  deviceType: type,
  externalId: id,
  linkedAt: 0,
  offlineAfterSeconds: 90,
});

test('MonitorIE adapter: converte chaves e unidades SM-WA confirmadas sem expor o JWT', async () => {
  const timestamp = Date.now() - 1000;
  const env = {
    MONITORIE_MODE: 'live',
    MONITORIE_SMWA_MAPPING: JSON.stringify({
      vazao: { key: 'flow', unit: 'L/min' },
      consumo_acumulado: { key: 'counter', unit: 'cL' },
      volume: { key: 'volume', unit: 'L' },
      rssi_wifi: { key: 'rssi', unit: 'dBm' },
    }),
  };
  const series = {
    flow: [{ ts: timestamp, value: 2 }],
    counter: [{ ts: timestamp, value: '12345' }],
    volume: [{ ts: timestamp, value: 800 }],
    rssi: [{ ts: timestamp, value: -55 }],
  };
  const client = {
    async latest(externalId, keys) {
      assert.equal(externalId, id);
      assert.deepEqual(keys, ['flow', 'counter', 'rssi', 'volume']);
      return series;
    },
    async history() {
      return { series, possiblyTruncated: false };
    },
  };
  const api = new MonitorieAPI(env, client);
  const snapshot = await api.snapshot(scope('SM-WA'));
  assert.equal(snapshot.device.status, 'online');
  assert.equal(snapshot.data.vazao, 120);
  assert.equal(snapshot.data.consumo_acumulado, 123.45);
  assert.equal(snapshot.data.volume, 800);
  assert.equal(snapshot.data.rssi_wifi, -55);
  assert.equal(JSON.stringify(snapshot).includes('JWT'), false);
});

test('MonitorIE adapter: histórico SM-WU preserva UTC, ordem e unidades canônicas', async () => {
  const first = Date.now() - 2000;
  const second = Date.now() - 1000;
  const env = {
    MONITORIE_MODE: 'live',
    MONITORIE_SMWU_MAPPING: JSON.stringify({
      distancia: { key: 'distance', unit: 'mm' },
      nivel: { key: 'level', unit: '%' },
      volume: { key: 'stored', unit: 'm3' },
      rssi_wifi: { key: 'rssi', unit: 'dBm' },
    }),
  };
  const points = (a, b) => [
    { ts: second, value: b },
    { ts: first, value: a },
  ];
  const series = {
    distance: points(200, 190),
    level: points(80, 81),
    stored: points(0.8, 0.81),
    rssi: points(-60, -59),
  };
  const client = {
    async latest() {
      return Object.fromEntries(Object.entries(series).map(([key, values]) => [key, [values[0]]]));
    },
    async history(externalId, keys, startMs, endMs, limit) {
      assert.equal(externalId, id);
      assert.deepEqual(keys, ['distance', 'level', 'stored', 'rssi']);
      assert.ok(startMs <= first);
      assert.ok(endMs >= second);
      assert.equal(limit, 10);
      return { series, possiblyTruncated: false };
    },
  };
  const rows = await new MonitorieAPI(env, client).history(scope('SM-WU'), Math.floor(first / 1000) - 1, 10);
  assert.deepEqual(
    rows.map((row) => [row.distancia, row.nivel, row.volume, row.timestamp]),
    [
      [20, 80, 800, new Date(first).toISOString()],
      [19, 81, 810, new Date(second).toISOString()],
    ],
  );
});

test('MonitorIE adapter: ausência total de medições é vazia; série parcial é rejeitada', async () => {
  const env = {
    MONITORIE_MODE: 'live',
    MONITORIE_SMWA_MAPPING: JSON.stringify({
      vazao: { key: 'flow', unit: 'L/h' },
      consumo_acumulado: { key: 'counter', unit: 'L' },
      rssi_wifi: { key: 'rssi', unit: 'dBm' },
    }),
  };
  const empty = { flow: [], counter: [], rssi: [] };
  const client = {
    async latest() {
      return empty;
    },
    async history() {
      return { series: empty, possiblyTruncated: false };
    },
  };
  const api = new MonitorieAPI(env, client);
  assert.equal((await api.snapshot(scope('SM-WA'))).data, null);
  assert.deepEqual(await api.history(scope('SM-WA'), 1, 10), []);

  client.latest = async () => ({ flow: [{ ts: Date.now(), value: 1 }], counter: [], rssi: [] });
  await assert.rejects(api.snapshot(scope('SM-WA')), code('MONITORIE_INVALID_DATA'));
});

test('MonitorIE adapter: mapping ausente, unidade desconhecida e chave duplicada falham fechado', async () => {
  const client = {
    async latest() {
      throw new Error('não deve chamar');
    },
    async history() {
      throw new Error('não deve chamar');
    },
  };
  await assert.rejects(
    new MonitorieAPI({ MONITORIE_MODE: 'live' }, client).snapshot(scope('SM-WA')),
    code('MONITORIE_NOT_CONFIGURED'),
  );
  for (const mapping of [
    {
      vazao: { key: 'flow', unit: 'gal/min' },
      consumo_acumulado: { key: 'counter', unit: 'L' },
      rssi_wifi: { key: 'rssi', unit: 'dBm' },
    },
    {
      vazao: { key: 'same', unit: 'L/h' },
      consumo_acumulado: { key: 'same', unit: 'L' },
      rssi_wifi: { key: 'rssi', unit: 'dBm' },
    },
  ])
    await assert.rejects(
      new MonitorieAPI(
        { MONITORIE_MODE: 'live', MONITORIE_SMWA_MAPPING: JSON.stringify(mapping) },
        client,
      ).snapshot(scope('SM-WA')),
      code('MONITORIE_NOT_CONFIGURED'),
    );
});
