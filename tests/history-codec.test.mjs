import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePoints,
  decodePoints,
  encodeLines,
  decodeLines,
  uvarint,
} from '../backend/dist/history-codec.js';
test('lossless point codecs preserve binary64 values, sparse safe integers and fractional steps', () => {
  for (const steps of [[0, 1, 2 ** 53 - 1], [-2, -0, 1.7e9 + 0.000001], [0]]) {
    const rows = steps.map((step, i) => ({
      step,
      value: [Number.MIN_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE][i],
    }));
    const b = encodePoints(rows),
      d = decodePoints(b);
    assert.deepEqual(
      [...d.steps],
      steps.map((v) => v || 0),
    );
    assert.deepEqual(
      [...d.values],
      rows.map((r) => r.value),
    );
    assert.throws(() => decodePoints({ ...b, n: b.n + 1 }), /Corrupt history block/);
    assert.throws(() => decodePoints({ ...b, vals: Buffer.from('bad') }), /Corrupt history block/);
  }
  const zero = decodePoints(encodePoints([{ step: -0, value: -0 }]));
  assert.equal(Object.is(zero.steps[0], -0), false);
  assert.equal(Object.is(zero.values[0], -0), false);
  assert.equal(uvarint(2 ** 53 - 1).length, 8);
});
test('stream frames preserve UTF-8, empty lines, sparse offsets and oversized records', () => {
  const rows = [
      { offset: 0, content: '' },
      { offset: 7, content: '你好 🧪\n' },
      { offset: 2 ** 53 - 1, content: 'x'.repeat(4 * 1024 ** 2 + 1) },
    ],
    b = encodeLines(rows, false);
  assert.deepEqual(decodeLines(b), rows);
  assert.throws(() => decodeLines({ ...b, n: 2 }), /Corrupt history block/);
  assert.throws(() => decodeLines({ ...b, bytes: 0 }), /Corrupt history block/);
});
