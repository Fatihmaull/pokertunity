/**
 * How many people may watch one match at once.
 *
 * Every spectator costs the dealing process work on every event, because the
 * feed is rendered and serialised per viewer. That is not an inefficiency to
 * optimise away: the per-viewer render is the redaction, and sharing one
 * rendered event across subscribers would put one viewer's hole cards in
 * another viewer's stream. So the cost is O(N) on the process that deals, and
 * the only safe lever is N.
 *
 * Held in memory, like the rate limits and for the same reason: a stream is a
 * fact about this process, and only the dealing process serves them.
 */

/**
 * The ceiling per match.
 *
 * Measured, not guessed. One six-seat table held a thousand subscribers without
 * its pacing slipping: hand times stayed in their unloaded range, CPU averaged
 * under five percent and p99 event-loop delay did not move. What did grow was
 * memory, about 0.2MB a subscriber, and the worst single stall, 125ms at a
 * thousand. Half of that is the cap, because a thousand was measured on one
 * table on a developer machine, and the process deals every match at once on
 * hardware that is probably smaller. Raise it only against a new measurement on
 * the hardware it will run on; the pull request that set it has the table.
 */
export const SPECTATOR_CAP = 500;

/**
 * The ceiling per caller per match.
 *
 * One person has the landing page and the table open, perhaps in a second tab.
 * Fifty streams from one caller is not a person, and is exactly the shape that
 * fills the match-wide cap and locks everybody else out. Signed-out callers are
 * counted by address, so a handful of people sharing one are still let in.
 */
export const SPECTATORS_PER_CALLER = 8;

interface Watching {
  total: number;
  byCaller: Map<string, number>;
}

const matches = new Map<string, Watching>();

export type Admission = { ok: true; release: () => void } | { ok: false; reason: 'full' | 'caller' };

/**
 * Takes a seat in the gallery, or says why there is none.
 *
 * The release is idempotent because a stream can end several ways at once, the
 * client leaving and the match finishing among them, and a slot handed back
 * twice would let the count drift below the truth.
 */
export function admit(matchId: string, who: string): Admission {
  const watching = matches.get(matchId) ?? { total: 0, byCaller: new Map<string, number>() };
  const mine = watching.byCaller.get(who) ?? 0;

  if (watching.total >= SPECTATOR_CAP) return { ok: false, reason: 'full' };
  if (mine >= SPECTATORS_PER_CALLER) return { ok: false, reason: 'caller' };

  watching.total += 1;
  watching.byCaller.set(who, mine + 1);
  matches.set(matchId, watching);

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;

      watching.total -= 1;
      const left = (watching.byCaller.get(who) ?? 1) - 1;
      if (left > 0) watching.byCaller.set(who, left);
      else watching.byCaller.delete(who);
      // A match nobody watches leaves nothing behind, so finished matches do
      // not accumulate here for the life of the process.
      if (watching.total === 0) matches.delete(matchId);
    },
  };
}
