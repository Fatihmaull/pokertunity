import { claimEngine, releaseEngine } from './engine-lock';
import { abandonOrphanedMatches, startMatchmaker, stopMatchmaker } from './matchmaker';
import { stopMatches } from './registry';

/**
 * Brings the arena up and takes it down cleanly. Booted by `server.ts` once the
 * port is bound; `instrumentation.ts` says why this is the one boot.
 */

/** How often an idle process offers to take over. */
const CLAIM_RETRY_MS = 15_000;

let retry: NodeJS.Timeout | null = null;
let announced = false;

export function bootEngine(): void {
  // A process told to stay idle serves pages. Useful for a second instance,
  // and for running the site against a database some other process is
  // already dealing on, with the lock left to that process.
  if (process.env.POKERTUNITY_DISABLE_ENGINE === '1') {
    console.log('[engine] disabled by POKERTUNITY_DISABLE_ENGINE. Serving pages.');
    return;
  }

  // Left to run in the background. A database that is slow or briefly down
  // delays the room opening while the server keeps serving; the matchmaker
  // keeps asking, so a late database means a late first match.
  void open();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (retry) clearTimeout(retry);
      retry = null;
      stopMatchmaker();
      stopMatches();
      // Handed back explicitly so a redeploy's replacement can start dealing
      // at once.
      void releaseEngine();
    });
  }
}

async function open(): Promise<void> {
  try {
    // Another process is already dealing. This one serves pages, which is
    // the correct behaviour for a second web instance: one engine deals each
    // hand once.
    if (!(await claimEngine())) {
      if (!announced) {
        console.log('[engine] another process is dealing. Serving pages.');
        announced = true;
      }
      return later();
    }

    // Any match still marked as being played was left mid-hand by a process
    // that went away. Having just won the lock, this one knows it is the one
    // dealer anywhere, which makes it the safe place to hand those chips back.
    const abandoned = await abandonOrphanedMatches();
    if (abandoned > 0) console.log(`[engine] returned the stacks from ${abandoned} abandoned match(es)`);

    startMatchmaker();
    console.log('[engine] dealing');
  } catch (error) {
    console.error('[engine] could not open the room', error);
    later();
  }
}

/**
 * Asks again shortly.
 *
 * A deploy overlaps: the replacement starts while the outgoing process still
 * holds the lock and loses the race, so it keeps asking and takes over once
 * the old process exits. Unreffed, so the server decides when the process
 * exits.
 */
function later(): void {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    void open();
  }, CLAIM_RETRY_MS);
  retry.unref();
}
