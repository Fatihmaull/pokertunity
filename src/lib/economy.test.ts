import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_BLIND,
  BUY_IN,
  BUY_IN_BB,
  ENTRY_FEE,
  ENTRY_FEE_BPS,
  DEFAULT_HAND_CAP,
  HAND_CAP,
  handCapFrom,
  MATCH,
  MAX_PURCHASE,
  MAX_SEATS,
  MIN_PURCHASE,
  MIN_SEATS,
  SEAT_COST,
  SMALL_BLIND,
  STARTING_GRANT,
  chipsToWei,
  formatNative,
  formatUsd,
  purchaseRefusal,
  weiToChips,
  WEI_PER_CHIP,
} from './economy';

test('the peg holds in both directions', () => {
  assert.equal(chipsToWei(1), WEI_PER_CHIP);
  assert.equal(chipsToWei(50_000), 500_000_000_000_000_000n, '50,000 chips is half a native token');
  assert.equal(weiToChips(chipsToWei(12_345)), 12_345);
});

test('a deposit that does not fill a chip buys nothing', () => {
  assert.equal(weiToChips(WEI_PER_CHIP - 1n), 0);
  assert.equal(weiToChips(WEI_PER_CHIP * 3n + 999n), 3);
});

test('rejects amounts that are not whole chips', () => {
  assert.throws(() => chipsToWei(1.5));
  assert.throws(() => chipsToWei(-1));
  assert.throws(() => weiToChips(-1n));
});

test('every seat in every match costs the same', () => {
  // The one change that neutralises a whale. A rich agent gets no deeper stack
  // and no better seat; all its money buys is more attempts.
  assert.equal(BUY_IN, BIG_BLIND * BUY_IN_BB);
  assert.equal(SEAT_COST, BUY_IN + ENTRY_FEE);
  assert.equal(MATCH.buyIn, BUY_IN);
  assert.equal(MATCH.entryFee, ENTRY_FEE);
});

test('the entry fee is small, whole, and charged at the door', () => {
  assert.equal(ENTRY_FEE, Math.floor((BUY_IN * ENTRY_FEE_BPS) / 10_000));
  assert.ok(Number.isInteger(ENTRY_FEE), 'chips are integers, fees included');
  assert.ok(ENTRY_FEE > 0, 'it is the only thing removing chips from the arena');
  assert.ok(ENTRY_FEE < BUY_IN / 20, `a fee of ${ENTRY_FEE} against a ${BUY_IN} buy-in is under five percent`);
});

test('the grant funds a few matches and no more', () => {
  const outright = Math.floor(STARTING_GRANT / SEAT_COST);
  assert.equal(outright, 4, `a new owner can sit ${outright} times even if their agent busts every one`);
  // The fifth seat is what is left over plus whatever came back. Four matches
  // that return a tenth of one buy-in between them are enough.
  assert.ok(STARTING_GRANT - outright * SEAT_COST + BUY_IN / 10 >= SEAT_COST, 'a fifth seat is within reach');
});

test('stacks are deep enough for the hand cap to bite without crushing anyone', () => {
  // Each agent posts roughly one and a half big blinds per orbit, so over the
  // cap the blinds alone eat a meaningful share of a stack. Enough to punish
  // folding, not enough to turn the end into a shoving contest.
  const blindsPaid = (HAND_CAP / MAX_SEATS) * 1.5;
  assert.ok(blindsPaid > BUY_IN_BB * 0.15, `blinds cost about ${blindsPaid.toFixed(0)} bb, which is pressure`);
  assert.ok(blindsPaid < BUY_IN_BB * 0.6, `blinds cost about ${blindsPaid.toFixed(0)} bb, which is not a squeeze`);
});

test('a match is between two and six, and knows its own shape', () => {
  assert.ok(MIN_SEATS >= 2, 'one player is not a game');
  assert.equal(MAX_SEATS, MATCH.seats);
  assert.equal(MATCH.handCap, HAND_CAP);
  assert.equal(MATCH.smallBlind, SMALL_BLIND);
  assert.equal(MATCH.bigBlind, BIG_BLIND);
});

test('the smallest purchase is the smallest deposit the vault takes', () => {
  // The vault is deployed with a minimum of 0.01 of the native token. Below
  // that the wallet would be asked to send a transaction that reverts.
  assert.equal(chipsToWei(MIN_PURCHASE), 10n ** 16n);
});

test('the cashier sells any whole number of chips in its range', () => {
  assert.equal(purchaseRefusal(MIN_PURCHASE), null);
  assert.equal(purchaseRefusal(12_345), null);
  assert.equal(purchaseRefusal(MAX_PURCHASE), null);

  for (const chips of [0, -1, MIN_PURCHASE - 1, MAX_PURCHASE + 1, 1_500.5, Number.NaN, Infinity]) {
    assert.equal(purchaseRefusal(chips), 'Buy between 1,000 and 1,000,000 chips.', `refuses ${chips}`);
  }
});

test('formats the native token without trailing noise', () => {
  assert.equal(formatNative(chipsToWei(10_000)), '0.1');
  assert.equal(formatNative(chipsToWei(50_000)), '0.5');
  assert.equal(formatNative(chipsToWei(250_000)), '2.5');
  assert.equal(formatNative(chipsToWei(12_345)), '0.12345', 'every chip shows, so the label is what the wallet asks');
  assert.equal(formatNative(chipsToWei(1)), '0.00001');
  assert.equal(formatNative(0n), '0');
});

test('a dollar hint is shown only where the chain carries a reference price', () => {
  assert.equal(formatUsd(chipsToWei(10_000), undefined), null, 'no rate means no figure, not a zero');
  assert.equal(formatUsd(chipsToWei(10_000), 600), '$60.00');
});

test('a hand cap that is not a hand count plays the default rather than an unplayable match', () => {
  // Both of these reach the runtime as a number without complaint: an empty
  // variable ends every match before a card is dealt, and a misspelled one
  // never ends a match at all.
  assert.equal(handCapFrom(''), DEFAULT_HAND_CAP);
  assert.equal(handCapFrom('thirty'), DEFAULT_HAND_CAP);
  assert.equal(handCapFrom('0'), DEFAULT_HAND_CAP);
  assert.equal(handCapFrom('12.5'), DEFAULT_HAND_CAP);
  assert.equal(handCapFrom(undefined), DEFAULT_HAND_CAP);

  assert.equal(handCapFrom('30'), 30);
  assert.equal(handCapFrom(' 30 '), 30);
});
