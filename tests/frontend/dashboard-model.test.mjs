import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardState, getConsumptionSeries } from '../../static/js/dashboard/model.js';

test('SM-WA consumption uses positive cumulative-counter differences and ignores resets', () => {
  dashboardState.reservoirs = [{ id: 1, device: { type: 'SM-WA' } }];
  dashboardState.selectedReservoirId = 1;
  dashboardState.historyMeta = { aggregation: 'none' };
  dashboardState.units = { consumo_acumulado: 'L' };
  const series = getConsumptionSeries([
    { timestamp: '2026-09-23T10:00:00Z', consumo_acumulado: 100 },
    { timestamp: '2026-09-23T10:10:00Z', consumo_acumulado: 103 },
    { timestamp: '2026-09-23T10:20:00Z', consumo_acumulado: 2 },
    { timestamp: '2026-09-23T10:30:00Z', consumo_acumulado: 4 },
  ]);
  assert.equal(series.available, true);
  assert.equal(series.total, 5);
  assert.deepEqual(
    series.points.map((point) => point.value),
    [3, 2],
  );
});

test('SM-WU consumption continues using reductions in reservoir volume', () => {
  dashboardState.reservoirs = [{ id: 2, device: { type: 'SM-WU' } }];
  dashboardState.selectedReservoirId = 2;
  dashboardState.historyMeta = { aggregation: 'none' };
  dashboardState.units = { volume: 'L' };
  const series = getConsumptionSeries([
    { timestamp: '2026-09-23T10:00:00Z', volume: 100 },
    { timestamp: '2026-09-23T10:10:00Z', volume: 97 },
    { timestamp: '2026-09-23T10:20:00Z', volume: 102 },
  ]);
  assert.equal(series.available, true);
  assert.equal(series.total, 3);
  assert.deepEqual(
    series.points.map((point) => point.value),
    [3],
  );
});
