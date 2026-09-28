import '../dev/test-env';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AGENTS_PER_ACCOUNT } from './credentials';
import { LIMITS, type LimitName, callerOf, take, tooMany } from './rate-limit';

/** The public reads, which anyone can call and the dealing process answers. */
const READS = ['axes', 'leaderboard', 'attestation', 'hands-latest', 'matches'] as const satisfies LimitName[];

/** A caller nobody else in this file shares, so the buckets cannot interfere. */
function someone(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

test('a burst is allowed and then the door closes', () => {
  const who = someone('burst');
  const { burst } = LIMITS['deposit-confirm'];

  for (let i = 0; i < burst; i++) {
    assert.equal(take('deposit-confirm', who).ok, true, `request ${i + 1} of the burst`);
  }

  const refused = take('deposit-confirm', who);
  assert.equal(refused.ok, false, 'the one after the burst is refused');
  assert.ok(refused.ok === false && refused.retryAfterMs > 0, 'and it says how long to wait');
});

test('one caller running out does not close the door on anybody else', () => {
  const noisy = someone('noisy');
  const quiet = someone('quiet');

  for (let i = 0; i < LIMITS['deposit-start'].burst + 5; i++) take('deposit-start', noisy);

  assert.equal(take('deposit-start', noisy).ok, false);
  assert.equal(take('deposit-start', quiet).ok, true, 'a limit is per caller, not a global tap');
});

test('limits are counted per route, not shared across them', () => {
  const who = someone('routes');
  for (let i = 0; i < LIMITS['deposit-start'].burst; i++) take('deposit-start', who);

  assert.equal(take('deposit-start', who).ok, false);
  assert.equal(take('deposit-confirm', who).ok, true, 'spending one allowance does not spend another');
});

test('an account is counted as itself, and a stranger by address', () => {
  const request = new Request('https://example.test/', {
    headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' },
  });

  assert.equal(callerOf(request, 'user-1'), 'user:user-1', 'an account outlives its address');
  assert.equal(callerOf(request, null), 'ip:70.41.3.18', 'the address the edge appended');
  assert.equal(callerOf(new Request('https://example.test/'), null), 'ip:unknown');
});

test('a stranger cannot pick their own bucket by writing the header', () => {
  // What the edge hands on when a caller sends x-forwarded-for themselves: the
  // forged value first, the connection it really came from appended after it.
  const forged = (claim: string) =>
    new Request('https://example.test/', { headers: { 'x-forwarded-for': `${claim}, 198.51.100.4` } });

  assert.equal(callerOf(forged('10.0.0.1'), null), callerOf(forged('10.0.0.2'), null));
});

test('the wait it quotes is long enough to actually succeed', async () => {
  const who = someone('refill');
  for (let i = 0; i < LIMITS.write.burst; i++) take('write', who);

  const refused = take('write', who);
  assert.equal(refused.ok, false);
  if (refused.ok) return;

  await new Promise((resolve) => setTimeout(resolve, refused.retryAfterMs + 25));
  assert.equal(take('write', who).ok, true, 'waiting the quoted time is enough');
});

test('hammering a public read ends in a 429 that says when to come back', async () => {
  const who = someone('hammer');
  let refused: ReturnType<typeof take> = { ok: true };
  for (let i = 0; i < 200 && refused.ok; i++) refused = take('axes', who);

  assert.equal(refused.ok, false, 'two hundred calls from one caller do not all get through');
  if (refused.ok) return;

  const response = tooMany(refused.retryAfterMs);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1, 'with a retry-after in whole seconds');
  assert.match(((await response.json()) as { error: string }).error, /Try again in/);
});

test('every read quotes a wait long enough to actually succeed', (context) => {
  // The real refill for the tightest read is six seconds. Moving the clock
  // tests the same arithmetic without making the suite wait for it.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  context.after(() => mock.timers.reset());

  for (const name of READS) {
    const who = someone(`wait-${name}`);
    for (let i = 0; i < LIMITS[name].burst; i++) take(name, who);

    const refused = take(name, who);
    assert.equal(refused.ok, false, `${name} refuses past its burst`);
    if (refused.ok) continue;

    // What the client is told, in the whole seconds the header carries.
    const seconds = Number(tooMany(refused.retryAfterMs).headers.get('retry-after'));
    mock.timers.tick(seconds * 1000);
    assert.equal(take(name, who).ok, true, `${name}: waiting the ${seconds}s in retry-after is enough`);
  }
});

test('the pages on this site never trip the limits on their own', () => {
  // The console fetches axes once per agent, all at once, for up to this many.
  assert.ok(LIMITS.axes.burst >= MAX_AGENTS_PER_ACCOUNT, 'a full console loads without a refusal');

  // Polling intervals from the components, times two tabs.
  const perMinute = (intervalMs: number) => (60_000 / intervalMs) * 2;
  assert.ok(LIMITS.leaderboard.perMinute >= perMinute(15_000), 'standings polls every fifteen seconds');
  assert.ok(LIMITS.matches.perMinute >= perMinute(5_000), 'the lobby polls every five seconds');
  assert.ok(LIMITS['hands-latest'].burst >= 2, 'the landing page asks once per load');
});

test('the costliest read is the tightest', () => {
  for (const name of READS) {
    if (name === 'axes') continue;
    assert.ok(LIMITS.axes.perMinute < LIMITS[name].perMinute, `axes is tighter than ${name}`);
  }
});
