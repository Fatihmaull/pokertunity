import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROCESS_SPECTATOR_CAP, SPECTATORS_PER_CALLER, SPECTATOR_CAP, admit as admitOnce } from './spectators';

/**
 * Every seat taken in a test is handed back after it. The process ceiling is
 * shared by every match, so seats left behind by one test would fill the
 * gallery for the next.
 */
const taken: Array<() => void> = [];
function admit(matchId: string, who: string): ReturnType<typeof admitOnce> {
  const seat = admitOnce(matchId, who);
  if (seat.ok) taken.push(seat.release);
  return seat;
}
afterEach(() => {
  for (const release of taken.splice(0)) release();
});

/** A match nobody else in this file watches, so the counts cannot interfere. */
function someMatch(): string {
  return `match-${Math.random().toString(36).slice(2)}`;
}

/** Fills a match to the cap from distinct callers, returning the releases. */
function fill(matchId: string): Array<() => void> {
  const releases: Array<() => void> = [];
  for (let i = 0; i < SPECTATOR_CAP; i++) {
    const seat = admit(matchId, `viewer-${i}`);
    assert.equal(seat.ok, true, `spectator ${i + 1} of ${SPECTATOR_CAP}`);
    if (seat.ok) releases.push(seat.release);
  }
  return releases;
}

test('a full gallery refuses the next viewer and says why', () => {
  const match = someMatch();
  fill(match);

  const refused = admit(match, 'latecomer');
  assert.deepEqual(refused, { ok: false, reason: 'full' });
});

test('a viewer leaving hands the seat to the next one', () => {
  const match = someMatch();
  const releases = fill(match);

  releases[0]!();
  assert.equal(admit(match, 'latecomer').ok, true);
});

test('handing a seat back twice does not make room for two', () => {
  const match = someMatch();
  const releases = fill(match);

  // The client leaving and the match ending can both close one stream.
  releases[0]!();
  releases[0]!();

  assert.equal(admit(match, 'first').ok, true);
  assert.deepEqual(admit(match, 'second'), { ok: false, reason: 'full' }, 'one release, one seat');
});

test('one caller cannot take the gallery for themselves', () => {
  const match = someMatch();
  for (let i = 0; i < SPECTATORS_PER_CALLER; i++) {
    assert.equal(admit(match, 'greedy').ok, true, `feed ${i + 1} from one caller`);
  }

  assert.deepEqual(admit(match, 'greedy'), { ok: false, reason: 'caller' });
  assert.equal(admit(match, 'somebody-else').ok, true, 'and everyone else still gets in');
});

test('a caller who closes a feed may open another', () => {
  const match = someMatch();
  let last: (() => void) | null = null;
  for (let i = 0; i < SPECTATORS_PER_CALLER; i++) {
    const seat = admit(match, 'tabs');
    if (seat.ok) last = seat.release;
  }

  last!();
  assert.equal(admit(match, 'tabs').ok, true);
});

test('matches are counted separately', () => {
  const full = someMatch();
  fill(full);

  assert.equal(admit(someMatch(), 'viewer-0').ok, true, 'a full match does not close another');
});

test('the per-caller ceiling sits well under the match ceiling', () => {
  // Otherwise a handful of callers fill the gallery between them, which is the
  // shape the per-caller ceiling exists to stop.
  assert.ok(SPECTATORS_PER_CALLER * 10 <= SPECTATOR_CAP);
});

test('the process ceiling holds across matches', () => {
  const matches = Array.from({ length: PROCESS_SPECTATOR_CAP / SPECTATOR_CAP }, someMatch);
  const releases = matches.flatMap(fill);

  assert.deepEqual(admit(someMatch(), 'newcomer'), { ok: false, reason: 'full' }, 'a fresh match is full too');

  releases[0]!();
  assert.equal(admit(someMatch(), 'newcomer').ok, true, 'and a seat anywhere frees one everywhere');
});
