// Reads /api/health the way PRELAUNCH D5 says to, and exits non-zero with the
// reasons when the room is not dealing. Run on a schedule by
// .github/workflows/health.yml; runnable by hand with HEALTH_URL set.
//
// A 200 is not the check. The route answers 200 while the engine is stalled,
// while stacks sit on a closed table, and while nobody at all is seated, and
// each of those is an arena a visitor cannot use.

const url = process.env.HEALTH_URL;
if (!url) {
  console.error('HEALTH_URL is not set');
  process.exit(2);
}

// How long a hand may go unfinished while agents are seated. A paced hand runs
// about a minute; five is an engine that has stopped, not a slow table.
const STALL_SECONDS = Number(process.env.STALL_SECONDS ?? 300);
// Between one match ending and the next being formed, nobody is seated for a
// matchmaker tick or two, and settlement is in flight for the same moment. Both
// conditions are read again after this long before they count.
const RECHECK_MS = Number(process.env.RECHECK_MS ?? 90_000);

async function read() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const problems = [];
let first = await read();
console.log('health:', first.status, JSON.stringify(first.body ?? first.error));

if (first.status !== 200 || first.body?.ok !== true) {
  problems.push(`not ok: status ${first.status}, ${first.body?.error ?? first.error ?? 'no body'}`);
} else {
  const health = first.body;
  if (health.dealing !== true) problems.push('dealing is false: no instance is running the room');
  if (health.seated > 0 && health.idleSeconds !== null && health.idleSeconds > STALL_SECONDS) {
    problems.push(`stalled: ${health.seated} seated and no hand finished for ${health.idleSeconds}s`);
  }

  if (health.unsettled > 0 || health.seated === 0) {
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
    const again = await read();
    console.log('recheck:', again.status, JSON.stringify(again.body ?? again.error));
    if (health.unsettled > 0 && again.body?.unsettled > 0) {
      problems.push(`unsettled: ${again.body.unsettled} finished match(es) still holding stacks`);
    }
    if (health.seated === 0 && again.body?.seated === 0) {
      problems.push(
        'empty: nobody seated on two reads. The demo field is down or its accounts are below SEAT_COST; see DEPLOY §6',
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('healthy');
