/**
 * A ceiling on how often one account can ask for the expensive things.
 *
 * Two routes here do real work on someone else's behalf. Confirming a deposit
 * makes two calls to a chain RPC against a transaction hash the caller chose,
 * and starting one writes a row. Each is harmless once, and both are a way to
 * spend this deployment's RPC quota or fill its tables from a single signed-in
 * account.
 *
 * The public reads are here for a different reason. Each is cheap to ask for
 * and costly to answer, is public, and runs on the same process that
 * deals the cards, so one client looping on any of them is felt at every table.
 *
 * Held in memory, which means per instance. That is worth being clear about: it
 * is a brake on ordinary abuse. It is still the right shape because it keeps
 * every request's path free of a database write, which matters more than
 * making a limit slightly harder to walk around.
 */

interface Bucket {
  /** Requests still available right now. Refills continuously. */
  tokens: number;
  lastRefill: number;
}

interface Limit {
  /** Requests allowed per minute, sustained. */
  perMinute: number;
  /** How many may arrive at once before the rate starts to bite. */
  burst: number;
}

/**
 * The limits, by what the route actually costs.
 *
 * Deposits are slow and rare in real use, so their allowance is small. Sign-in
 * is bounded loosely: a person retrying a wallet prompt is normal, and keeping
 * them in their own account is worth the nonces they waste.
 *
 * The reads are sized from below by what this site's own pages ask for, with
 * room for a second tab. The interface stays inside every limit on its own:
 *
 * - `axes` reads up to five thousand results and every decision in them, then
 *   computes in memory. The console asks once per agent and an account runs at
 *   most eight, so the burst covers a full console and a reload. The rate after
 *   that is the tightest of the reads, because this is the query that costs most.
 * - `leaderboard` places every agent, then aggregates the results of one page
 *   of them and of the viewer's own. The standings page polls it every fifteen
 *   seconds and asks again on every page turned, so the burst lets somebody
 *   page through quickly.
 * - `attestation` runs that same aggregate for one agent while its record is
 *   still unpublished. Verifiers fetch it after reading the chain, rarely.
 *   A single published attestation by id shares the bucket.
 * - `registration` is one agent row and its handful of mints, but it is what an
 *   identity's URI resolves to, so ERC-8004 indexers crawl it. Looser than the
 *   aggregates for that reason and because it is cheap.
 * - `hands-latest` reads a whole hand and its decisions while the room is idle.
 *   The landing page asks once per load.
 * - `matches` is a handful of rows: every live match and one page of ended
 *   ones. Every open lobby polls it every five seconds, and the matches page
 *   asks again on every page of history turned. Loose on purpose, since
 *   signed-out people behind one address share a bucket.
 */
export const LIMITS = {
  'deposit-confirm': { perMinute: 10, burst: 5 },
  'deposit-start': { perMinute: 10, burst: 5 },
  'sign-in': { perMinute: 30, burst: 10 },
  write: { perMinute: 30, burst: 10 },
  axes: { perMinute: 10, burst: 16 },
  leaderboard: { perMinute: 40, burst: 20 },
  attestation: { perMinute: 20, burst: 10 },
  registration: { perMinute: 60, burst: 20 },
  'hands-latest': { perMinute: 30, burst: 10 },
  matches: { perMinute: 120, burst: 30 },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

const buckets = new Map<string, Bucket>();

/** Long enough that a bucket at full tokens is safe to forget. */
const IDLE_MS = 10 * 60_000;
let lastSweep = Date.now();

/**
 * Spends one request against a caller's allowance.
 *
 * Returns how long to wait when the allowance is spent, so the caller can say
 * so in a `Retry-After`.
 */
export function take(name: LimitName, who: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const limit = LIMITS[name];
  const key = `${name}:${who}`;
  const now = Date.now();

  sweep(now);

  const bucket = buckets.get(key) ?? { tokens: limit.burst, lastRefill: now };
  const refilled = ((now - bucket.lastRefill) / 60_000) * limit.perMinute;
  bucket.tokens = Math.min(limit.burst, bucket.tokens + refilled);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / limit.perMinute) * 60_000) };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { ok: true };
}

/**
 * A refusal shaped the way the rest of the API refuses things.
 *
 * `Retry-After` is in whole seconds because that is what the header means, and
 * rounding up is the honest direction: a client that waits the number it was
 * given should succeed.
 */
export function tooMany(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.` },
    { status: 429, headers: { 'retry-after': String(seconds) } },
  );
}

/**
 * Who to count this against.
 *
 * An account where there is one, because that is the thing being limited and it
 * survives a change of address. Signed-out callers fall back to the address the
 * proxy saw.
 *
 * That is the *last* entry of `x-forwarded-for`. Railway's edge appends the
 * address it accepted the connection from and keeps whatever the client sent
 * ahead of it, so the last entry is the one the caller cannot write, and every
 * signed-out limit and the per-caller spectator cap rest on it. Should another proxy ever sit
 * in front of the edge, the last entry becomes that proxy and every stranger
 * shares a bucket: too strict, and loud, which is the right way to be wrong.
 *
 * Lacking a forwarded address, every stranger lands in one bucket, and on a
 * read the whole lobby polls, that bucket is a global tap. Behind the proxy
 * this deployment runs on the header is always set, so its absence in
 * production means the proxy changed, and the warning says so once, up front.
 */
export function callerOf(request: Request, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (!forwarded && !warnedUnknown && process.env.NODE_ENV === 'production') {
    warnedUnknown = true;
    console.warn('rate limit: a request arrived lacking x-forwarded-for; every such caller shares one bucket');
  }
  return `ip:${forwarded || 'unknown'}`;
}

let warnedUnknown = false;

/** Drops idle buckets, so a long-running process keeps memory flat. */
function sweep(now: number): void {
  if (now - lastSweep < IDLE_MS) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_MS) buckets.delete(key);
  }
}
