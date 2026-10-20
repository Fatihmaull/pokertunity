import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRate } from './stats';

test('the rate is the per-hand average expressed per hundred hands', () => {
  assert.equal(winRate(1000, 0.05, 8).rate, 5);
  assert.equal(winRate(1000, -0.12, 8).rate, -12);
});

test('the floor sits below the rate and closes on it as hands pile up', () => {
  const thin = winRate(100, 0.05, 8);
  const thick = winRate(100_000, 0.05, 8);

  assert.ok(thin.floor !== null && thick.floor !== null);
  assert.ok(thin.floor < thin.rate, 'the published number is the pessimistic one');
  assert.ok(thick.floor > thin.floor, 'more hands, less doubt');

  // Worth reading as a fact about poker. At a realistic spread of eight big
  // blinds a hand, a hundred hands says very little, and even a hundred thousand still leaves several big blinds per
  // hundred of doubt, which is the size of a real edge.
  assert.ok(thin.rate - thin.floor > 100, 'a hundred hands is still noise');
  assert.ok(thick.rate - thick.floor < 6, 'a hundred thousand hands narrows it to about five');
});

test('a proven record outranks a hot run over few hands', () => {
  const lucky = winRate(40, 1.5, 8); // 150 bb/100 over forty hands
  const proven = winRate(50_000, 0.06, 8); // 6 bb/100 over fifty thousand

  assert.ok(lucky.rate > proven.rate, 'the raw rate does favour the lucky agent');
  assert.ok(lucky.floor !== null && proven.floor !== null);
  assert.ok(proven.floor > lucky.floor, 'the ranked number favours the proven record');
});

test('too few hands gives a null interval, which sorts last', () => {
  assert.equal(winRate(1, 0.5, 8).floor, null);
  assert.equal(winRate(0, 0, 0).floor, null);
  // A sample with zero spread is untested.
  assert.equal(winRate(500, 0.05, 0).floor, null);
});
