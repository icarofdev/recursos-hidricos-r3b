import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({
  entryPoints: ['cloudflare/reservoir-volume.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { calculateVolume, validateConfiguration } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
);
const config = { empty_distance_cm: 120, full_distance_cm: 20, sensor_min_cm: 10, tolerance_cm: 1 };
const row = (geometry = 'uniform', extra = {}) => ({
  geometry,
  capacity_liters: 1000,
  measurement_config: JSON.stringify({ ...config, ...extra }),
});
test('uniform section uses sensor offset and useful height: empty, half, full', () => {
  for (const [distance, liters] of [
    [120, 0],
    [70, 500],
    [20, 1000],
    [121, 0],
    [19, 1000],
  ])
    assert.equal(calculateVolume(row(), distance).volume, liters);
  assert.equal(calculateVolume(row(), 70).nivel, 50);
});
test('horizontal cylinder circular segments differ from proportional height', () => {
  assert.equal(calculateVolume(row('horizontal_cylinder', { diameter_cm: 100 }), 120).volume, 0);
  assert.ok(
    Math.abs(calculateVolume(row('horizontal_cylinder', { diameter_cm: 100 }), 70).volume - 500) < 1e-8,
  );
  assert.ok(
    Math.abs(
      calculateVolume(row('horizontal_cylinder', { diameter_cm: 100 }), 95).volume - 195.501109477885,
    ) < 1e-8,
  );
  assert.equal(calculateVolume(row('horizontal_cylinder', { diameter_cm: 100 }), 20).volume, 1000);
  // A useful maximum below the top normalizes against that measured capacity.
  const partial = { ...row('horizontal_cylinder', { diameter_cm: 200 }) };
  assert.ok(Math.abs(calculateVolume(partial, 70).volume - 391.00221895577) < 1e-8);
});
test('irregular shape interpolates measured calibration and reports volume percentage', () => {
  const calibrated = row('calibration', {
    points: [
      { height_cm: 0, liters: 0 },
      { height_cm: 50, liters: 300 },
      { height_cm: 100, liters: 1000 },
    ],
  });
  for (const [distance, liters] of [
    [120, 0],
    [95, 150],
    [70, 300],
    [45, 650],
    [20, 1000],
  ])
    assert.equal(calculateVolume(calibrated, distance).volume, liters);
  assert.equal(calculateVolume(calibrated, 70).nivel, 30);
  assert.ok(Math.abs(calculateVolume(calibrated, 120 - 50 - (200 / 700) * 50).volume - 500) < 1e-8);
});
test('missing, non-finite, outside range and below minimum never fabricate volume', () => {
  for (const distance of [null, undefined, '70', NaN, Infinity, -1, 9, 18, 122, 10000])
    assert.equal(calculateVolume(row(), distance).volume, null);
  assert.equal(
    calculateVolume({ ...row(), measurement_config: null }, 70).measurement_quality,
    'configuration_missing',
  );
  assert.throws(() => validateConfiguration('uniform', 1000, { ...config, full_distance_cm: 5 }), /Confira/);
  assert.throws(() => validateConfiguration('uniform', 1000, { ...config, tolerance_cm: 6 }), /Confira/);
  assert.throws(
    () => validateConfiguration('horizontal_cylinder', 1000, { ...config, diameter_cm: 50 }),
    /Confira/,
  );
  assert.throws(
    () =>
      validateConfiguration('calibration', 1000, {
        ...config,
        points: [
          { height_cm: 0, liters: 0 },
          { height_cm: 100, liters: 900 },
        ],
      }),
    /Confira/,
  );
  assert.throws(
    () =>
      validateConfiguration('calibration', 1000, {
        ...config,
        points: [
          { height_cm: 0, liters: 0 },
          { height_cm: 80, liters: 800 },
          { height_cm: 50, liters: 500 },
          { height_cm: 100, liters: 1000 },
        ],
      }),
    /Confira/,
  );
});
