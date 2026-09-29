import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSigned } from './format';

test('signs a gain with a plus and a loss with a true minus', () => {
  assert.equal(formatSigned(2124), '+2,124');
  assert.equal(formatSigned(-40), '−40');
});

test('leaves zero unsigned', () => {
  assert.equal(formatSigned(0), '0');
  assert.equal(formatSigned(-0), '0');
});

test('decides the sign after rounding, so nothing prints as a signed zero', () => {
  assert.equal(formatSigned(-0.04, 1), '0.0');
  assert.equal(formatSigned(0.04, 1), '0.0');
  assert.equal(formatSigned(-0.06, 1), '−0.1');
});

test('keeps the requested decimals', () => {
  assert.equal(formatSigned(1.5, 1), '+1.5');
  assert.equal(formatSigned(3, 1), '+3.0');
});
