import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const baseline = process.env.HIDRA_TELEMETRY_BASELINE_REVISION;
if (baseline && !/^[a-f0-9]{7,40}$/i.test(baseline)) throw new Error('Invalid baseline revision');
const publicSource = (file) =>
  baseline
    ? Promise.resolve(
        execFileSync('git', ['show', baseline + ':' + file], { encoding: 'utf8', windowsHide: true }),
      )
    : readFile(file, 'utf8');
const { dashboardState, getRangeHistory, getTodayHistory } = baseline
  ? await import(
      'data:text/javascript;base64,' +
        Buffer.from(await publicSource('static/js/dashboard/model.js')).toString('base64')
    )
  : await import('../../static/js/dashboard/model.js');

test('A23: rolling 24h chart retains yesterday while calendar-day metrics remain separate', () => {
  const originalNow = Date.now;
  const stamp = new Date(2026, 9, 18, 0, 30).getTime();
  Date.now = () => stamp;
  try {
    dashboardState.selectedRangeHours = 24;
    // Use local dates around midnight so this does not depend on the host timezone.
    const yesterday = new Date(2026, 9, 17, 23, 45).toISOString();
    const today = new Date(2026, 9, 18, 0, 15).toISOString();
    dashboardState.history = [{ timestamp: yesterday }, { timestamp: today }];
    assert.deepEqual(
      getRangeHistory().map((row) => row.timestamp),
      [yesterday, today],
    );
    // getTodayHistory intentionally uses the calendar day. Its clock is a Date constructor.
    const currentDate = new Date();
    const priorDate = new Date(currentDate);
    priorDate.setDate(priorDate.getDate() - 1);
    dashboardState.history = [
      { timestamp: priorDate.toISOString() },
      { timestamp: currentDate.toISOString() },
    ];
    assert.deepEqual(
      getTodayHistory().map((row) => row.timestamp),
      [currentDate.toISOString()],
    );
  } finally {
    Date.now = originalNow;
  }
});

async function dashboardHarness() {
  const source = await publicSource('static/js/dashboard.js');
  const compiled = await build({
    stdin: {
      contents:
        source +
        `
        renderAll = () => {}; renderMetrics = () => {}; renderInsights = () => {};
        renderHistoryTable = () => {}; renderSystemStatus = () => {};
        globalThis.reviewHooks = {dashboardState, updateDashboard, clearRefreshTimer, renderConnection};`,
      resolveDir: resolve('static/js'),
      loader: 'js',
    },
    plugins: [
      {
        name: 'headless-chart-presentation',
        setup(builder) {
          if (baseline)
            builder.onLoad({ filter: /dashboard[\\/]model\.js$/ }, async () => ({
              contents: await publicSource('static/js/dashboard/model.js'),
              loader: 'js',
            }));
          builder.onLoad({ filter: /dashboard[\\/]charts\.js$/ }, () => ({
            contents: `export const historyChart=null,consumptionChart=null;
          export const showChartState=()=>{},hideChartState=()=>{},getChartColors=()=>{},baseChartOptions=()=>{},initializeCharts=()=>{},renderChart=()=>{},renderConsumption=()=>{};`,
            loader: 'js',
          }));
        },
      },
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  let stamp = 1800000000000,
    nextTimer = 0;
  const timers = new Map(),
    calls = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, { hidden: false, textContent: '', classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const document = {
    hidden: false,
    querySelector: () => null,
    addEventListener() {},
    getElementById: element,
  };
  class TestDate extends Date {
    static now() {
      return stamp;
    }
  }
  let responseOverride;
  const sandbox = {
    Date: TestDate,
    document,
    URLSearchParams,
    AbortController,
    window: {
      setTimeout(fn, delay) {
        const id = ++nextTimer;
        timers.set(id, { fn, due: stamp + delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      clearInterval() {},
      location: { assign() {} },
    },
    async fetch(url) {
      const parsed = new URL(url, 'https://app.synthetic.test');
      calls.push({ path: parsed.pathname, hours: parsed.searchParams.get('hours'), at: stamp });
      if (responseOverride) return responseOverride(parsed);
      return Response.json(
        parsed.pathname.endsWith('/history')
          ? { success: true, id: 1, data: [], meta: { aggregation: 'none' } }
          : { success: true, data: null, device: { id: 1, status: 'online' }, units: {} },
      );
    },
  };
  vm.runInNewContext(compiled.outputFiles[0].text, sandbox);
  const hooks = sandbox.reviewHooks;
  hooks.dashboardState.reservoirs = [{ id: 1, device: { id: 1, request_interval_seconds: 70 } }];
  hooks.dashboardState.selectedReservoirId = 1;
  hooks.dashboardState.historyVisible = true;
  hooks.dashboardState.refreshMilliseconds = 300000;
  async function advance(milliseconds) {
    const end = stamp + milliseconds;
    while (true) {
      const pending = [...timers]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!pending) break;
      const [id, timer] = pending;
      stamp = timer.due;
      timers.delete(id);
      timer.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    stamp = end;
  }
  return {
    hooks,
    calls,
    advance,
    document,
    timers,
    setResponse: (override) => {
      responseOverride = override;
    },
  };
}

test('A10: initial MonitorIE history and changed range resume exactly when the local gate opens', async () => {
  const { hooks, calls, advance, timers } = await dashboardHarness();
  const initial = 1800000000000;
  await hooks.updateDashboard();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/device/snapshot');
  assert.equal(timers.size, 1);
  await advance(69999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/device/history');
  assert.equal(calls[1].at, initial + 70000);
  assert.equal(hooks.dashboardState.historyLastLoadedAt, initial + 70000);
  await advance(10000);
  hooks.dashboardState.selectedRangeHours = 168;
  hooks.dashboardState.historyRequestPending = true;
  await hooks.updateDashboard();
  await advance(20000);
  hooks.dashboardState.selectedRangeHours = 720;
  hooks.dashboardState.historyRequestPending = true;
  await hooks.updateDashboard();
  assert.equal(timers.size, 1, 'Range changes coalesce into one pending request');
  await advance(40000);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].hours, '720');
  assert.equal(calls[2].at, initial + 140000);
  assert.equal(hooks.dashboardState.historyLoadedRangeHours, 720);
});

test('A10: hidden dashboard cancels pending history and resumes on visibility update', async () => {
  const { hooks, calls, advance, document, timers } = await dashboardHarness();
  await hooks.updateDashboard();
  document.hidden = true;
  hooks.clearRefreshTimer();
  assert.equal(timers.size, 0);
  await advance(70000);
  assert.equal(calls.length, 1);
  document.hidden = false;
  await hooks.updateDashboard();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/device/history');
});

test('A10: provider contention schedules Retry-After; permanent initial failures do not spin', async () => {
  const { hooks, calls, advance, setResponse } = await dashboardHarness();
  await hooks.updateDashboard();
  let unavailable = true;
  setResponse(() =>
    unavailable
      ? Response.json(
          { success: false, error: { code: 'MONITORIE_RATE_LIMITED', message: 'synthetic contention' } },
          { status: 503, headers: { 'Retry-After': '120' } },
        )
      : Response.json({ success: true, id: 1, data: [], meta: { aggregation: 'none' } }),
  );
  await advance(70000);
  assert.equal(calls.length, 2);
  await advance(119999);
  assert.equal(calls.length, 2);
  unavailable = false;
  await advance(1);
  assert.equal(calls.length, 3);
  assert.equal(hooks.dashboardState.historyError, false);

  const failed = await dashboardHarness();
  failed.hooks.dashboardState.reservoirs[0].device.request_interval_seconds = 0;
  failed.setResponse(() =>
    Response.json(
      { success: false, error: { code: 'FAILED', message: 'synthetic failure' } },
      { status: 503 },
    ),
  );
  await failed.hooks.updateDashboard();
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.timers.size, 0);
  assert.equal(failed.hooks.dashboardState.apiAvailable, false);
});

test('unknown MonitorIE status is never rendered as an Online connection', async () => {
  const { hooks, document } = await dashboardHarness();
  hooks.dashboardState.device = { id: 1, status: 'unknown', last_seen: null };
  hooks.renderConnection();
  assert.equal(document.getElementById('connection-label').textContent, 'Sem confirmação');
  assert.match(document.getElementById('connection-dot').className, /is-warning/);
});
