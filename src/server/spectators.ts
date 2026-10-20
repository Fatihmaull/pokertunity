/**
 * How many people may watch one match at once.
 *
 * Every spectator costs the dealing process work on every event, because the
 * feed is rendered and serialised per viewer. That cost is the point: the
 * per-viewer render is the redaction, which keeps each viewer's stream to what
 * that viewer may see. So the cost is O(N) on the process that deals, and N is
 * the safe lever.
 *
 * Held in memory, like the rate limits and for the same reason: a stream is a
 * fact about this process, and the dealing process is the one that serves them.
 */

/**
 * The ceiling per match.
 *
 * Measured. One six-seat table held a thousand subscribers with its pacing
 * intact: hand times stayed in their unloaded range, CPU averaged under five
 * percent and p99 event-loop delay held flat. What did grow was
 * memory, about 0.2MB a subscriber, and the worst single stall, 125ms at a
 * thousand. Half of that is the cap, because a thousand was measured on one
 * table on a developer machine, and the process deals every match at once on
 * hardware that is probably smaller. Raise it against a new measurement on
 * the hardware it will run on; the pull request that set it has the table.
 */
export const SPECTATOR_CAP = 500;

/**
 * The ceiling per caller per match.
 *
 * One person has the landing page and the table open, perhaps in a second tab.
 * Fifty streams from one caller is a script, and exactly the shape that would
 * fill the match-wide cap for everybody else. Signed-out callers are
 * counted by address, so a handful of people sharing one are still let in.
 */
export const SPECTATORS_PER_CALLER = 8;

/**
 * The ceiling across every match on this process.
 *
 * The match ceiling alone let the total grow with the number of tables, and
 * one process deals them all. Measured on four live tables at once: event-loop
 * p99 held under 100ms to 4,000 spectators and reached 380ms at 8,000, while
 * hand times, being pacing, held steady. Half the last flat point, by the same
 * reasoning as the match ceiling, and the pull request that set it has the
 * table.
 */
export const PROCESS_SPECTATOR_CAP = 2000;

let watchingAll = 0;

interface Watching {
  total: number;
  byCaller: Map<string, number>;
}

const matches = new Map<string, Watching>();

export type Admission = { ok: true; release: () => void } | { ok: false; reason: 'full' | 'caller' };

/**
 * Takes a seat in the gallery, or says why the gallery is full.
 *
 * The release is idempotent because a stream can end several ways at once, the
 * client leaving and the match finishing among them, and a slot handed back
 * twice would let the count drift below the truth.
 */
export function admit(matchId: string, who: string): Admission {
  const watching = matches.get(matchId) ?? { total: 0, byCaller: new Map<string, number>() };
  const mine = watching.byCaller.get(who) ?? 0;

  if (watching.total >= SPECTATOR_CAP || watchingAll >= PROCESS_SPECTATOR_CAP) return { ok: false, reason: 'full' };
  if (mine >= SPECTATORS_PER_CALLER) return { ok: false, reason: 'caller' };

  watching.total += 1;
  watchingAll += 1;
  watching.byCaller.set(who, mine + 1);
  matches.set(matchId, watching);

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;

      watching.total -= 1;
      watchingAll -= 1;
      const left = (watching.byCaller.get(who) ?? 1) - 1;
      if (left > 0) watching.byCaller.set(who, left);
      else watching.byCaller.delete(who);
      // A match with zero watchers is dropped from the map, so memory stays
      // flat for the life of the process.
      if (watching.total === 0) matches.delete(matchId);
    },
  };
}
