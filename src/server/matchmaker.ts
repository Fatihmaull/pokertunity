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
 * converges on zero. That is why the standings rank on the rating, and why the
 * bands here are deliberately loose.
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
 * Loose on purpose. A loose band fills six-handed tables from a small field
 * and keeps results meaningful at scale. Its job is to keep the strongest away
 * from the weakest.
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
 * Stacks go back to their owners and ratings stay as they were. A match the
 * server walked out of measures the server, and ending it cleanly keeps a rare
 * case simple.
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
  // the chips land, so settling first gets those agents back in the queue.
  for (const matchId of [...unsettled().keys()]) await settle(matchId);

  // Readiness is a fact about the sockets this process holds, so it is read
  // from the connections. The arena seats agents that are here, because a
  // match holds every seat until it ends.
  const ready = readyAgents();

  // Before the gate below. An agent whose owner cannot cover a seat is dropped
  // from the queue query in silence, so this is where it hears why it is
  // waiting.
  await explain([...ready.keys()]);

  if (ready.size < MIN_SEATS) return;

  // Longest wait first, measured from when each agent asked on its socket.
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
 * Tells each waiting agent whether it is queued, and why it is waiting when it
 * is.
 *
 * The connection remembers what it last said, so an answer goes out when it
 * changes: an agent refused once knows where it stands, and the arena that
 * caps how often an agent may speak keeps to the same courtesy. Kept on the
 * connection, so an agent that reconnects is told afresh.
 */
async function explain(ready: readonly string[]): Promise<void> {
  const statuses = await seatingStatus(ready);

  for (const status of statuses) {
    // Playing, so its own match is the answer.
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
 * them, so a lonely agent at the edge of the field gets a wider net as it
 * waits. A group that is still filling and still inside its wait is left in
 * the queue to try again.
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
      // be a pair by construction: the owner sees both sets of
      // cards, and one can fold every pot the other contests until the chips
      // have moved to whichever account they want them in.
      if (owners.has(candidate.ownerId)) continue;

      group.push(candidate);
      owners.add(candidate.ownerId);
      pool.splice(pool.indexOf(candidate), 1);
    }

    // A short table is a real game and a full one is a better game, so a group
    // that could still fill up is put back to wait for its minute.
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
 * Matches whose runtime has finished and whose chips are still on the way
 * back.
 *
 * Kept and retried every tick until it lands. Until then the seats stay written
 * and the match stays marked as playing, so its agents wait to queue and their
 * stacks sit on a closed table.
 *
 * Parked on `globalThis` because the health check counts it from a route, and a
 * route resolves to its own copy of this module: `globalThis` is the one map
 * the engine and `/api/health` both see, so stacks stuck on a closed table are
 * reported truthfully.
 */
const globalForSettlement = globalThis as unknown as {
  __pokertunityUnsettled?: Map<string, Pending>;
};

function unsettled(): Map<string, Pending> {
  if (!globalForSettlement.__pokertunityUnsettled) globalForSettlement.__pokertunityUnsettled = new Map();
  return globalForSettlement.__pokertunityUnsettled;
}

/** Settlements running right now, so each retry waits for the attempt before it. */
const settling = new Set<string>();

/** How many finished matches are still holding chips, for the health check. */
export function unsettledMatches(): number {
  return unsettled().size;
}

/**
 * Closes out a match the moment its runtime says it is done.
 *
 * Settling deliberately lives here, apart from the runtime. It returns chips
 * and rewrites ratings, and that work stays apart from the loop that deals
 * cards. The runtime is dropped at once, since its dealing is done; the chips
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
 * produced, and it exists once the finishing order does. Every entrant is told,
 * rated and unrated alike: an abandoned match still ended, and every agent is
 * owed that frame. The wait restarts here because time at a table is separate
 * from time in the queue, and the rating band widens with the queue.
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
