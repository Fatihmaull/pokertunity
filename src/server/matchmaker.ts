import { MAX_SEATS, MIN_SEATS, SEAT_COST, formatChips } from '../lib/economy';
import { QUEUE_OFF_REASON, linkFor, readyAgents } from './presence';
import { closeMatch, openMatch } from './registry';
import { conservative } from '../lib/rating';
import {
  createMatch,
  handsDealt,
  liveMatchIds,
  queuedAgents,
  seatingStatus,
  settleMatch,
  type Candidate,
  type MatchEnding,
  type Settlement,
} from './store';

/**
 * Who plays whom.
 *
 * Agents queue, and this puts them into a match against opponents of similar
 * rating, so that a match measures how an agent plays a hand.
 *
 * Matching by rating has one consequence worth being honest about. If it works
 * perfectly, everyone faces opponents of their own strength and every win rate
 * converges on nothing. That is why the standings rank on the rating rather
 * than on chips won, and why the bands here are deliberately loose rather than
 * tight.
 */

/** How often the queue is looked at. Frequent enough to feel immediate, cheap enough to ignore. */
const TICK_MS = 5_000;

/**
 * How long a full table is worth waiting for.
 *
 * Six-handed is the better game, so a queue that is one short is given a minute
 * to fill before settling for what it has. Beyond that an empty arena is worse
 * than a short match.
 */
const FULL_TABLE_WAIT_MS = 60_000;

/**
 * How far apart two agents can be rated and still be seated together.
 *
 * Loose on purpose. A tight band would sort a small field into matches of two
 * and, at scale, would flatten every result to a coin flip. This is meant to
 * keep the strongest away from the weakest, not to manufacture dead heats.
 */
const BAND_START = 6;

/** How much the band opens up for every minute somebody has been waiting. */
const BAND_GROWTH_PER_MINUTE = 6;

const globalForFloor = globalThis as unknown as {
  __pokertunityFloor?: { timer: NodeJS.Timeout | null };
};

function floor(): { timer: NodeJS.Timeout | null } {
  if (!globalForFloor.__pokertunityFloor) globalForFloor.__pokertunityFloor = { timer: null };
  return globalForFloor.__pokertunityFloor;
}

export function startMatchmaker(): void {
  const state = floor();
  if (state.timer) return;

  state.timer = setInterval(() => {
    void guardedTick();
  }, TICK_MS);

  void guardedTick();
}

/**
 * One tick at a time.
 *
 * A tick reads the queue and then seats it, and seating is several writes. If
 * one ran long enough to overlap the next, both would read the same agents as
 * unseated and both would charge them for a seat, because the row that would
 * have stopped it is written by the transaction still in flight.
 */
let ticking = false;

async function guardedTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } catch (error) {
    console.error('[matchmaker] tick failed', error);
  } finally {
    ticking = false;
  }
}

export function stopMatchmaker(): void {
  const state = floor();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/**
 * Returns every match that was being dealt when the last process went away.
 *
 * Stacks go back to their owners and nobody is rated. A match the server walked
 * out of says nothing about how well anyone played, and resuming one would mean
 * storing and replaying its whole state for a case that should be rare.
 */
export async function abandonOrphanedMatches(): Promise<number> {
  const orphaned = await liveMatchIds();

  for (const matchId of orphaned) {
    try {
      // Counted from the hands themselves. The runtime that knew the tally went
      // away with the process, and recording a zero would deny hands that were
      // dealt and stored.
      const dealt = await handsDealt(matchId);
      announce(matchId, 'abandoned', dealt, await settleMatch(matchId, 'abandoned', dealt));
    } catch (error) {
      console.error(`[matchmaker] could not abandon ${matchId}`, error);
    }
  }

  return orphaned.length;
}

async function tick(): Promise<void> {
  // Settlements that failed last time go first. Their agents stay seated until
  // the chips land, so every tick one waits is a tick those agents cannot queue.
  for (const matchId of [...unsettled().keys()]) await settle(matchId);

  // Readiness is a fact about the sockets this process holds, so it is read
  // from the connections rather than from a column. An agent that is not here
  // cannot be seated, because a match holds every seat until it ends.
  const ready = readyAgents();

  // Before the gate below, not after. An agent whose owner cannot cover a seat
  // is dropped from the queue query in silence, and the one thing worse than
  // not being seated is not being told why: the agent says ready, the arena
  // says nothing, and no match ever arrives.
  await explain([...ready.keys()]);

  if (ready.size < MIN_SEATS) return;

  // Longest wait first, measured from when each agent asked rather than from
  // anything the database remembers about it.
  const waiting = (await queuedAgents([...ready.keys()]))
    .map((candidate) => ({ ...candidate, waitingSince: ready.get(candidate.agentId) ?? Date.now() }))
    .sort((a, b) => a.waitingSince - b.waitingSince);

  if (waiting.length < MIN_SEATS) return;

  for (const group of groupsFrom(waiting)) {
    const match = await createMatch(group);
    if (!match) continue;

    console.log(`[matchmaker] opened ${match.id} with ${group.map((entrant) => entrant.name).join(', ')}`);
    openMatch(match.id, match.number, match.config, onFinished);
  }
}

/**
 * Tells each waiting agent whether it is queued, and why not when it is not.
 *
 * The connection remembers what it last said, so an answer goes out when it
 * changes rather than every few seconds: an agent refused once and then left
 * alone knows where it stands, and one told the same sentence twelve times a
 * minute is being flooded by the arena that caps how often it may speak. Kept
 * on the connection rather than here, so an agent that reconnects is told
 * afresh instead of inheriting silence from the socket it replaced.
 */
async function explain(ready: readonly string[]): Promise<void> {
  const statuses = await seatingStatus(ready);

  for (const status of statuses) {
    // Playing, so its own match is the answer to why it is not in another one.
    if (status.playing) continue;

    const link = linkFor(status.agentId);
    if (!link) continue;

    // The switch lives in the database and an owner can flip it from any
    // instance, so the connection's copy is brought up to date here.
    link.setQueueOpen(status.queueEnabled);
    link.tellQueue(
      !status.queueEnabled
        ? QUEUE_OFF_REASON
        : status.chips < SEAT_COST
          ? `A seat costs ${formatChips(SEAT_COST)} chips and this account holds ${formatChips(status.chips)}. Buy chips at the cashier.`
          : null,
    );
  }
}

type Entrant = Candidate & { waitingSince: number };

/**
 * Splits the queue into the matches that should start right now.
 *
 * Whoever has waited longest anchors a table, and the band is drawn around
 * them, so a lonely agent at the edge of the field gets a wider net rather than
 * waiting forever for a neighbour who never arrives. A group that is not yet
 * full and has not waited long enough is left in the queue to try again.
 */
function groupsFrom(waiting: readonly Entrant[], now = Date.now()): Entrant[][] {
  // Longest wait first: the queue is already in that order, and rebuilding it
  // by rating would quietly prioritise whoever happened to rate highest.
  const pool = [...waiting];
  const groups: Entrant[][] = [];

  while (pool.length >= MIN_SEATS) {
    const anchor = pool.shift()!;
    const waited = now - anchor.waitingSince;
    const band = BAND_START + (waited / 60_000) * BAND_GROWTH_PER_MINUTE;

    const group = [anchor];
    const owners = new Set([anchor.ownerId]);

    for (const candidate of [...pool]) {
      if (group.length >= MAX_SEATS) break;
      if (Math.abs(candidate.published - anchor.published) > band) continue;
      // One owner, one seat. Two agents with the same owner at one table would
      // be a pair without ever agreeing anything: the owner sees both sets of
      // cards, and one can fold every pot the other contests until the chips
      // have moved to whichever account they want them in.
      if (owners.has(candidate.ownerId)) continue;

      group.push(candidate);
      owners.add(candidate.ownerId);
      pool.splice(pool.indexOf(candidate), 1);
    }

    // A short table is a real game and a full one is a better game, so a group
    // that could still fill up is put back rather than started early.
    if (group.length < MAX_SEATS && waited < FULL_TABLE_WAIT_MS) {
      pool.unshift(...group);
      break;
    }

    if (group.length < MIN_SEATS) {
      pool.unshift(...group.slice(1));
      continue;
    }

    groups.push(group);
  }

  return groups;
}

type Pending = { ending: MatchEnding; hands: number };

/**
 * Matches whose runtime has finished but whose chips have not gone back yet.
 *
 * Kept and retried every tick until it lands. Until then the seats stay written
 * and the match stays marked as playing, so its agents cannot queue and their
 * stacks sit on a table nobody is dealing.
 *
 * Parked on `globalThis` because the health check counts it from a route, and a
 * route does not resolve to the copy of this module the engine runs in: a
 * module-level map would be filled by the engine while `/api/health` counted an
 * empty one, and stacks stuck on a closed table would be reported as none.
 */
const globalForSettlement = globalThis as unknown as {
  __pokertunityUnsettled?: Map<string, Pending>;
};

function unsettled(): Map<string, Pending> {
  if (!globalForSettlement.__pokertunityUnsettled) globalForSettlement.__pokertunityUnsettled = new Map();
  return globalForSettlement.__pokertunityUnsettled;
}

/** Settlements running right now, so a retry never overlaps the attempt it retries. */
const settling = new Set<string>();

/** How many finished matches are still holding chips, for the health check. */
export function unsettledMatches(): number {
  return unsettled().size;
}

/**
 * Closes out a match the moment its runtime says it is done.
 *
 * Settling is deliberately not the runtime's job. It returns chips and rewrites
 * ratings, and none of that belongs tangled up with the loop that deals cards.
 * The runtime is dropped at once, since it has nothing left to deal; the chips
 * are the part that is retried until it lands.
 */
function onFinished(matchId: string, ending: MatchEnding, hands: number): void {
  closeMatch(matchId);
  unsettled().set(matchId, { ending, hands });
  void settle(matchId);
}

async function settle(matchId: string): Promise<void> {
  const pending = unsettled().get(matchId);
  if (!pending || settling.has(matchId)) return;

  settling.add(matchId);
  try {
    const settlement = await settleMatch(matchId, pending.ending, pending.hands);
    unsettled().delete(matchId);
    announce(matchId, pending.ending, pending.hands, settlement);
  } catch (error) {
    console.error(`[matchmaker] could not settle ${matchId}, trying again next tick`, error);
  } finally {
    settling.delete(matchId);
  }
}

/**
 * Tells every entrant the match is over, and starts each one's wait again.
 *
 * Told after settling, because the rating in the frame is the one the match
 * produced and it does not exist until the finishing order does. Every entrant
 * is told, not only the rated ones: an abandoned match still ended, and an agent
 * never told so waits for a frame that is not coming. The wait restarts here
 * because time spent at a table is not time spent in the queue, and the rating
 * band widens with the queue.
 */
function announce(matchId: string, ending: MatchEnding, hands: number, settlement: Settlement): void {
  const placed = new Map(settlement.finishes.map((finish) => [finish.agentId, finish]));
  const now = Date.now();

  for (const entrant of settlement.entrants) {
    const finish = placed.get(entrant.agentId);
    const link = linkFor(entrant.agentId);

    link?.send({
      type: 'match-end',
      matchId,
      ending,
      handsPlayed: hands,
      place: finish?.place ?? null,
      entrants: settlement.entrants.length,
      finalStack: entrant.finalStack,
      rating: finish ? { before: conservative(finish.before), after: conservative(finish.after) } : null,
    });
    link?.requeue(now);
  }

  for (const finish of [...settlement.finishes].sort((a, b) => a.place - b.place)) {
    const moved = finish.after.mu - finish.before.mu;
    console.log(
      `[matchmaker] ${matchId} #${finish.place} ${finish.name} ` +
        `stack ${finish.finalStack} rating ${finish.after.mu.toFixed(1)} (${moved >= 0 ? '+' : ''}${moved.toFixed(1)})`,
    );
  }
}
