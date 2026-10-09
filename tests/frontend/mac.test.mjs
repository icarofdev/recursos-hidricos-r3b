import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMac } from '../../static/js/mac.js';
test('MAC typing/pasting accepts one byte sequence and never duplicates separators', () => {
  for (const value of ['aabbccddeeff', 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF'])
    assert.equal(formatMac(value), 'AA:BB:CC:DD:EE:FF');
  assert.equal(formatMac('aa:b'), 'AA:B');
  assert.equal(formatMac(''), '');
  assert.equal(formatMac('aa::bb'), 'AA:BB');
});
