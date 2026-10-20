import { TransactionRollbackError, and, count, desc, eq, inArray, isNotNull, isNull, sql as raw } from 'drizzle-orm';

import { db } from '../db/client';
import {
  agents,
  decisions,
  hands,
  ledgerEntries,
  matchResults,
  matches,
  results,
  seats,
  users,
} from '../db/schema';
import type { Card } from '../poker/cards';
import type { HandEvent, HandState } from '../poker/engine';
import type { DecisionRecord } from '../agent/decide';
import { MATCH, SEAT_COST, type MatchConfig } from '../lib/economy';
import { conservative, updateRatings, type Rating } from '../lib/rating';

export interface SeatedAgent {
  seatIndex: number;
  agentId: string;
  name: string;
  color: string;
  stack: number;
  /** Hand this seat went broke on, or null while it still has chips. */
  bustedAtHand: number | null;
}

export async function loadSeats(matchId: string): Promise<SeatedAgent[]> {
  const rows = await db
    .select({
      seatIndex: seats.seatIndex,
      agentId: agents.id,
      name: agents.name,
      color: agents.color,
      stack: seats.stack,
      bustedAtHand: seats.bustedAtHand,
    })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.matchId, matchId))
    .orderBy(seats.seatIndex);

  return rows;
}

/**
 * Marks the seats a hand is being played with, so the hand owns them until it
 * is stored.
 *
 * The other writer is the code that abandons a match after a restart. That is
 * rare, and this is what makes it safe as well as rare.
 */
export async function markInHand(matchId: string, seatIndexes: number[]): Promise<number[]> {
  if (seatIndexes.length === 0) return [];

  const claimed = await db
    .update(seats)
    .set({ inHand: true })
    .where(and(eq(seats.matchId, matchId), inArray(seats.seatIndex, seatIndexes)))
    .returning({ seatIndex: seats.seatIndex });

  return claimed.map((row) => row.seatIndex);
}

/** Releases every seat in a match once the hand is on record. */
export async function clearInHand(matchId: string): Promise<void> {
  await db.update(seats).set({ inHand: false }).where(eq(seats.matchId, matchId));
}

/** An owner's chip balance. Read on connect so an agent can say why it is idle. */
export async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.chips ?? 0;
}

/**
 * Why each connected agent is waiting outside a match.
 *
 * The queue query below silently drops anyone who cannot cover a seat, which is
 * correct for matchmaking and leaves the owner guessing: their agent says it is
 * ready and waits. This returns the same facts unfiltered so the matchmaker can
 * tell the agent why on the socket.
 */
export async function seatingStatus(
  readyIds: readonly string[],
): Promise<Array<{ agentId: string; chips: number; playing: boolean; queueEnabled: boolean }>> {
  if (readyIds.length === 0) return [];

  const rows = await db
    .select({ agentId: agents.id, chips: users.chips, seatId: seats.id, queueEnabled: agents.queueEnabled })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(inArray(agents.id, [...readyIds]));

  return rows.map((row) => ({
    agentId: row.agentId,
    chips: row.chips,
    playing: row.seatId !== null,
    queueEnabled: row.queueEnabled,
  }));
}

export interface Candidate {
  agentId: string;
  name: string;
  ownerId: string;
  rating: Rating;
  /** The published figure, which is what the bands are drawn on. */
  published: number;
  /** Matches finished. Zero means the published figure is a starting point. */
  matchesPlayed: number;
}

/**
 * Everyone waiting for a game, out of those currently connected and ready.
 *
 * Readiness lives on the socket: an agent is looking for a game when it has a
 * socket open and has said so on it. The caller passes in who that is, because
 * the process holding the sockets is the one that knows, and this adds the
 * three conditions the database owns: its owner has switched matches on, it is
 * unseated, and it is able to cover a seat.
 *
 * How long each has waited is deliberately left to the caller. The socket an
 * agent asked on is what knows when it asked.
 */
export async function queuedAgents(readyIds: readonly string[]): Promise<Candidate[]> {
  if (readyIds.length === 0) return [];

  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      ownerId: users.id,
      mu: agents.ratingMu,
      sigma: agents.ratingSigma,
      matchesPlayed: agents.matchesPlayed,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(
      and(
        inArray(agents.id, [...readyIds]),
        eq(agents.queueEnabled, true),
        isNull(seats.id),
        raw`${users.chips} >= ${SEAT_COST}`,
      ),
    );

  return rows.map((row) => {
    const rating: Rating = { mu: row.mu, sigma: row.sigma };
    return {
      agentId: row.agentId,
      name: row.name,
      ownerId: row.ownerId,
      rating,
      published: conservative(rating),
      matchesPlayed: row.matchesPlayed,
    };
  });
}

/**
 * The band a match was drawn from, or null for a field of newcomers.
 *
 * Averaged over every entrant, unrated ones included, because that is what the
 * matchmaker actually banded on. A field of newcomers averages zero by
 * construction, and floating point hands back a hair either side of it, since
 * mu minus three sigma over a stored default lands there. Recording it as null
 * is both safer to read and the truer claim: a field still to be rated.
 */
function bandOf(entrants: readonly Candidate[]): number | null {
  if (entrants.every((entrant) => entrant.matchesPlayed === 0)) return null;
  return entrants.reduce((sum, entrant) => sum + entrant.published, 0) / entrants.length;
}

/**
 * Opens a match and seats everyone in it, as one transaction.
 *
 * The buy-in and the fee both leave the owner's balance here, so chips are
 * always in exactly one place, a seat or a balance. An entrant that cannot be
 * charged is dropped, so every seat is paid for; if that leaves too
 * few players the whole thing rolls back and the matchmaker tries again next
 * tick with whoever is still there.
 */
export async function createMatch(
  entrants: readonly Candidate[],
): Promise<{ id: string; number: number; config: MatchConfig } | null> {
  if (entrants.length < 2) return null;

  return db.transaction(async (tx): Promise<{ id: string; number: number; config: MatchConfig } | null> => {
    const [match] = await tx
      .insert(matches)
      .values({
        status: 'playing',
        seatCount: MATCH.seats,
        smallBlind: MATCH.smallBlind,
        bigBlind: MATCH.bigBlind,
        buyIn: MATCH.buyIn,
        entryFee: MATCH.entryFee,
        handCap: MATCH.handCap,
        bandRating: bandOf(entrants),
        startedAt: new Date(),
      })
      .returning();

    let seated = 0;

    for (const entrant of entrants) {
      // Conditional on the balance still covering it, so an agent charged for
      // another match between the queue being read and this running is simply
      // left out, and every balance stays at zero or above.
      const [debited] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} - ${SEAT_COST}` })
        .where(and(eq(users.id, entrant.ownerId), raw`${users.chips} >= ${SEAT_COST}`))
        .returning({ chips: users.chips });

      if (!debited) continue;

      // Two entries, because they are two different things. One is chips moving
      // onto a table and coming back; the other is the house's cut, which stays.
      await tx.insert(ledgerEntries).values([
        {
          userId: entrant.ownerId,
          delta: -MATCH.buyIn,
          balanceAfter: debited.chips + MATCH.entryFee,
          reason: 'match-buy-in' as const,
          reference: match.id,
        },
        {
          userId: entrant.ownerId,
          delta: -MATCH.entryFee,
          balanceAfter: debited.chips,
          reason: 'entry-fee' as const,
          reference: match.id,
        },
      ]);

      // Densely numbered from zero. An entrant that failed the balance check
      // above leaves the numbering dense, because the seats a match opens with
      // are the seats it has for good.
      await tx.insert(seats).values({
        matchId: match.id,
        seatIndex: seated,
        agentId: entrant.agentId,
        stack: MATCH.buyIn,
      });
      seated += 1;
    }

    if (seated < 2) {
      tx.rollback();
      return null;
    }

    // The table is as big as the field that turned up. The field is fixed for
    // the whole match, so every chair has someone in it and every screen counts
    // the seats truthfully.
    await tx.update(matches).set({ seatCount: seated }).where(eq(matches.id, match.id));

    // The row's own figures. A match describes itself for its
    // whole life, so one dealt under different settings still plays by the ones
    // it was opened with.
    return {
      id: match.id,
      number: match.number,
      config: {
        seats: seated,
        smallBlind: match.smallBlind,
        bigBlind: match.bigBlind,
        buyIn: match.buyIn,
        entryFee: match.entryFee,
        handCap: match.handCap,
      },
    };
  }).catch((error: unknown) => {
    // `rollback` throws, so a match that could not seat two arrives here.
    // Catching it keeps the matchmaker's tick going for every other group it
    // had formed.
    if (error instanceof TransactionRollbackError) return null;
    throw error;
  });
}

/** How a match came to an end, which decides whether anybody is rated for it. */
export type MatchEnding = 'elimination' | 'cap' | 'abandoned';

export interface Finish {
  agentId: string;
  name: string;
  place: number;
  finalStack: number;
  bustedAtHand: number | null;
  before: Rating;
  after: Rating;
}

/** What closing a match came to. */
export interface Settlement {
  /** Everyone who held a seat, rated and unrated, and the stack each was paid back. */
  entrants: Array<{ agentId: string; finalStack: number }>;
  /** Places and ratings. Empty for an abandoned match. */
  finishes: Finish[];
}

/**
 * Closes a match: returns every stack, works out the finishing order, and
 * updates everybody's rating from it.
 *
 * An abandoned match returns the chips and leaves ratings as they were: a match
 * the server walked out of measures the server. Its entrants are still named,
 * because each of them is owed being told it ended.
 */
export async function settleMatch(matchId: string, ending: MatchEnding, handsPlayed: number): Promise<Settlement> {
  return db.transaction(async (tx): Promise<Settlement> => {
    const rows = await tx
      .select({
        agentId: seats.agentId,
        name: agents.name,
        seatIndex: seats.seatIndex,
        stack: seats.stack,
        bustedAtHand: seats.bustedAtHand,
        userId: agents.userId,
        mu: agents.ratingMu,
        sigma: agents.ratingSigma,
      })
      .from(seats)
      .innerJoin(agents, eq(agents.id, seats.agentId))
      .where(eq(seats.matchId, matchId))
      .for('update', { of: seats });

    for (const row of rows) {
      // Every stack above zero goes back to the owner it was taken from,
      // whatever place the agent finished in.
      if (row.stack <= 0) continue;

      const [updated] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${row.stack}` })
        .where(eq(users.id, row.userId))
        .returning({ chips: users.chips });

      await tx.insert(ledgerEntries).values({
        userId: row.userId,
        delta: row.stack,
        balanceAfter: updated.chips,
        reason: 'match-cash-out',
        reference: matchId,
      });
    }

    await tx.delete(seats).where(eq(seats.matchId, matchId));
    await tx
      .update(matches)
      .set({ status: ending, handsPlayed, endedAt: new Date() })
      .where(eq(matches.id, matchId));

    // Ratings move after a match that ran to its end with two or more
    // entrants: an abandoned match measures the server, and a place needs
    // somebody to be placed above.
    const entrants = rows.map((row) => ({ agentId: row.agentId, finalStack: row.stack }));
    if (ending === 'abandoned' || rows.length < 2) return { entrants, finishes: [] };

    const placed = rows.map((row) => ({
      row,
      place: placeOf(row, rows),
      rating: { mu: row.mu, sigma: row.sigma } satisfies Rating,
    }));

    const updatedRatings = updateRatings(
      placed.map((entry) => ({ entrant: entry.row.agentId, rating: entry.rating, place: entry.place })),
    );

    const finishes: Finish[] = [];

    for (const [index, entry] of placed.entries()) {
      const after = updatedRatings[index].rating;

      await tx.insert(matchResults).values({
        matchId,
        agentId: entry.row.agentId,
        place: entry.place,
        // Copied off the seat here because the seats are gone by the time
        // anybody asks a finished match who sat where.
        seatIndex: entry.row.seatIndex,
        finalStack: entry.row.stack,
        bustedAtHand: entry.row.bustedAtHand,
        ratingMuBefore: entry.rating.mu,
        ratingSigmaBefore: entry.rating.sigma,
        ratingMuAfter: after.mu,
        ratingSigmaAfter: after.sigma,
      });

      await tx
        .update(agents)
        .set({
          ratingMu: after.mu,
          ratingSigma: after.sigma,
          matchesPlayed: raw`${agents.matchesPlayed} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, entry.row.agentId));

      finishes.push({
        agentId: entry.row.agentId,
        name: entry.row.name,
        place: entry.place,
        finalStack: entry.row.stack,
        bustedAtHand: entry.row.bustedAtHand,
        before: entry.rating,
        after,
      });
    }

    return { entrants, finishes };
  });
}

/**
 * Where one agent finished, counting how many genuinely did better.
 *
 * Anyone still holding chips finishes above everyone eliminated, ordered by how
 * many they hold. Among the eliminated, going out later is the better finish.
 * Equal results share a place, which the rating reads as a tie.
 */
function placeOf(
  self: { stack: number; bustedAtHand: number | null },
  field: ReadonlyArray<{ stack: number; bustedAtHand: number | null }>,
): number {
  const better = field.filter((other) => {
    const otherAlive = other.bustedAtHand === null;
    const selfAlive = self.bustedAtHand === null;

    if (otherAlive !== selfAlive) return otherAlive;
    if (otherAlive) return other.stack > self.stack;
    return (other.bustedAtHand ?? 0) > (self.bustedAtHand ?? 0);
  });

  return better.length + 1;
}

/** Matches a dead process was dealing. Stacks returned, ratings left as they were. */
export async function liveMatchIds(): Promise<string[]> {
  const rows = await db.select({ id: matches.id }).from(matches).where(eq(matches.status, 'playing'));
  return rows.map((row) => row.id);
}

/**
 * How many hands a match actually got through, counted from the hands.
 *
 * The runtime keeps its own tally, and a process recovering somebody else's
 * abandoned match reads the stored hands, which are the truth. Money and
 * rating both ignore this figure, which is exactly why it is worth getting
 * right: an unchecked number is the one that quietly drifts.
 */
export async function handsDealt(matchId: string): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(hands)
    .where(eq(hands.matchId, matchId));

  return row?.count ?? 0;
}

/** A decision as it is stored with its hand. */
export interface RecordedDecision {
  /** Engine position, which is what the lineup stored beside it is indexed by. */
  seatIndex: number;
  agentId: string;
  record: DecisionRecord;
  street: string;
  /**
   * What the action came to, read off this decision's own event: the level
   * reached for a bet or a raise, the chips put in for a call. Reading it off
   * this decision's own event is what ties it to this decision.
   */
  amount: number;
}

export interface PersistedHand {
  matchId: string;
  handNumber: number;
  /** The deck as dealt, off the end. What a replay deals from. */
  deck: readonly Card[];
  state: HandState;
  startedAt: Date;
  bigBlind: number;
  /** In engine order: `seatIndex` is the position, `chair` the seat row it plays from. */
  lineup: Array<{ seatIndex: number; chair: number; agentId: string; name: string; startingStack: number }>;
  decisions: RecordedDecision[];
  outcomes: HandOutcome[];
}

/**
 * Stores a finished hand and everything it changed, as one transaction.
 *
 * The hand, its decisions, the results and counters, the stacks it left, the
 * seats it knocked out and the release of the seats land together, all at
 * once. One transaction keeps the results, the counters and the stacks
 * describing the same hand, and the next hand deals from the stacks this one
 * left.
 */
export async function recordHand(hand: PersistedHand): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(hands)
      .values({
        matchId: hand.matchId,
        handNumber: hand.handNumber,
        deck: [...hand.deck],
        button: hand.state.button,
        // Stored in the shape replays already read. The chair is the runtime's
        // business; the stored hand is indexed by position throughout.
        lineup: hand.lineup.map(({ seatIndex, agentId, name, startingStack }) => ({
          seatIndex,
          agentId,
          name,
          startingStack,
        })),
        board: hand.state.board,
        pots: hand.state.pots,
        events: hand.state.events satisfies HandEvent[],
        startedAt: hand.startedAt,
        endedAt: new Date(),
      })
      .returning({ id: hands.id });

    if (hand.decisions.length > 0) {
      await tx.insert(decisions).values(
        hand.decisions.map((entry) => ({
          handId: row.id,
          agentId: entry.agentId,
          seatIndex: entry.seatIndex,
          street: entry.street,
          equity: entry.record.equity.equity,
          handRead: entry.record.read,
          reasoning: entry.record.reasoning,
          say: entry.record.say,
          action: entry.record.action.type,
          amount: entry.amount,
          elapsedMs: entry.record.elapsedMs,
          outcome: entry.record.outcome,
        })),
      );
    }

    if (hand.outcomes.length > 0) {
      const filed = await tx
        .insert(results)
        .values(
          hand.outcomes.map((outcome) => ({
            handId: row.id,
            agentId: outcome.agentId,
            matchId: hand.matchId,
            bigBlind: hand.bigBlind,
            startingStack: outcome.startingStack,
            net: outcome.net,
            showdown: outcome.showdown,
            opponents: outcome.opponents,
            opponentRating: outcome.opponentRating,
          })),
        )
        .onConflictDoNothing()
        .returning({ agentId: results.agentId });

      // The counters follow the rows that actually went in. A result row that
      // already existed was already counted, and counting it again would move
      // a profile's numbers away from the rows every metric is computed from.
      const counted = new Set(filed.map((entry) => entry.agentId));

      for (const outcome of hand.outcomes) {
        if (!counted.has(outcome.agentId)) continue;
        await tx
          .update(agents)
          .set({
            handsPlayed: raw`${agents.handsPlayed} + 1`,
            handsWon: raw`${agents.handsWon} + ${outcome.won ? 1 : 0}`,
            chipsWon: raw`${agents.chipsWon} + ${outcome.net}`,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, outcome.agentId));
      }
    }

    for (const seat of hand.lineup) {
      const stack = hand.state.seats[seat.seatIndex].stack;
      const chair = and(eq(seats.matchId, hand.matchId), eq(seats.seatIndex, seat.chair));

      await tx.update(seats).set({ stack }).where(chair);

      // A stack short of the big blind is out of the match. The
      // hand number fixes finishing order among everyone who went out, and the
      // stack is deliberately left alone: those chips are still the owner's and
      // go back at settlement like anyone else's.
      if (stack < hand.bigBlind) {
        await tx
          .update(seats)
          .set({ bustedAtHand: hand.handNumber })
          .where(and(chair, isNull(seats.bustedAtHand)));
      }
    }

    // The chips are on record, so every seat is released from the hand.
    await tx.update(seats).set({ inHand: false }).where(eq(seats.matchId, hand.matchId));

    await tx
      .update(matches)
      .set({ handsPlayed: hand.handNumber })
      .where(eq(matches.id, hand.matchId));
  });
}

export interface HandOutcome {
  agentId: string;
  won: boolean;
  net: number;
  startingStack: number;
  /** Whether the hand was decided by comparing cards. */
  showdown: boolean;
  opponents: number;
  /** Average published rating of those opponents, as it stood when the hand was dealt. */
  opponentRating: number;
}

/** The most recently completed hand anywhere, for the landing page replay. */
export async function latestHand(): Promise<{
  id: string;
  matchId: string;
  handNumber: number;
  lineup: unknown;
  events: unknown;
  board: unknown;
} | null> {
  const [row] = await db
    .select({
      id: hands.id,
      matchId: hands.matchId,
      handNumber: hands.handNumber,
      lineup: hands.lineup,
      events: hands.events,
      board: hands.board,
    })
    .from(hands)
    .where(isNotNull(hands.endedAt))
    .orderBy(desc(hands.endedAt))
    .limit(1);

  return row ?? null;
}

export async function decisionsForHand(handId: string) {
  return db.select().from(decisions).where(eq(decisions.handId, handId)).orderBy(decisions.id);
}

/** Current ratings for a set of agents, for anything that needs them mid-match. */
export async function ratingsOf(agentIds: string[]): Promise<Map<string, Rating>> {
  if (agentIds.length === 0) return new Map();

  const rows = await db
    .select({ id: agents.id, mu: agents.ratingMu, sigma: agents.ratingSigma })
    .from(agents)
    .where(inArray(agents.id, agentIds));

  return new Map(rows.map((row) => [row.id, { mu: row.mu, sigma: row.sigma }]));
}

/** A match as any instance can describe it, from the database. */
export interface StoredMatch {
  matchId: string;
  number: number;
  status: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
  handsPlayed: number;
  bandRating: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** Ended matches to a page of the floor's history. */
export const HISTORY_PAGE = 20;

/**
 * Every match being dealt and one page of the ones that have ended, read from
 * the database.
 *
 * One instance deals, and every instance serves the lobby, so the lobby reads
 * the database that all of them share and tells the same truth everywhere.
 *
 * The live matches come with every page. There are few of them, and keeping
 * them on every page keeps the floor visibly live.
 */
export async function storedMatches(page = 1): Promise<{ matches: StoredMatch[]; page: number; pages: number }> {
  // Abandoned matches belong here too, so a match somebody had chips in stays
  // on the floor after the process dealing it went away, and the entrant can
  // find it.
  const ended = inArray(matches.status, ['elimination', 'cap', 'abandoned']);

  const [{ total }] = await db.select({ total: count() }).from(matches).where(ended);
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const current = Math.min(Math.max(1, Math.floor(page)), pages);

  const playing = await db.select().from(matches).where(eq(matches.status, 'playing')).orderBy(desc(matches.startedAt));
  const history = await db
    .select()
    .from(matches)
    .where(ended)
    // The id settles ties, so a page boundary falls in the same place on every read.
    .orderBy(raw`${matches.endedAt} desc nulls last`, desc(matches.id))
    .limit(HISTORY_PAGE)
    .offset((current - 1) * HISTORY_PAGE);

  return {
    matches: [...playing, ...history].map((row) => ({
      matchId: row.id,
      number: row.number,
      status: row.status,
      seatCount: row.seatCount,
      smallBlind: row.smallBlind,
      bigBlind: row.bigBlind,
      buyIn: row.buyIn,
      handCap: row.handCap,
      handsPlayed: row.handsPlayed,
      bandRating: row.bandRating,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    })),
    page: current,
    pages,
  };
}

/** What a match is called, for its page's title. Null for an unknown id. */
export async function matchNumber(matchId: string): Promise<number | null> {
  const [row] = await db.select({ number: matches.number }).from(matches).where(eq(matches.id, matchId)).limit(1);
  return row?.number ?? null;
}

export interface MatchEntrant {
  agentId: string;
  name: string;
  color: string;
  /** Null for an abandoned match, which ends unplaced. */
  place: number | null;
  finalStack: number | null;
  bustedAtHand: number | null;
  /** Published rating before and after, or null for an abandoned match. */
  ratingBefore: number | null;
  ratingAfter: number | null;
  /** Chips won and lost across the hands actually played. */
  net: number;
}

export interface MatchSummary {
  matchId: string;
  number: number;
  status: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  entryFee: number;
  handCap: number;
  handsPlayed: number;
  startedAt: Date | null;
  endedAt: Date | null;
  entrants: MatchEntrant[];
  /** The viewer's own agent among the entrants, if it had a seat here. */
  mine: string | null;
  /**
   * What the viewer's own account got back, if it had a seat here. Zero for an
   * agent that went out empty: the ledger skips a zero stack, and the owner is
   * still owed being told.
   */
  cashOut: number | null;
}

/**
 * A match that is over, as something a reader can actually be shown.
 *
 * A finished match's runtime is gone and its feed answers 503, so this reads
 * everything from the database.
 *
 * Two shapes come back, because two things can have happened. A match that ran
 * to an elimination or to the cap has a finishing order in `matchResults`. One
 * the server walked out of ends unplaced and leaves ratings as they were, so
 * its entrants are recovered from the hands that were played, and the
 * summary says plainly that the match ended unplaced.
 */
export async function matchSummary(matchId: string, viewerUserId: string | null): Promise<MatchSummary | null> {
  const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!row) return null;

  // Chips won and lost per agent, which exists for every match that dealt a
  // hand, abandoned ones included. It is the one per-agent figure an abandoned match
  // leaves behind, since its seats are deleted and it writes zero result rows.
  const nets = await db
    .select({ agentId: results.agentId, net: raw<number>`sum(${results.net})::int`, name: agents.name, color: agents.color })
    .from(results)
    .innerJoin(agents, eq(agents.id, results.agentId))
    .where(eq(results.matchId, matchId))
    .groupBy(results.agentId, agents.name, agents.color);

  const placed = await db
    .select({
      agentId: matchResults.agentId,
      place: matchResults.place,
      finalStack: matchResults.finalStack,
      bustedAtHand: matchResults.bustedAtHand,
      muBefore: matchResults.ratingMuBefore,
      sigmaBefore: matchResults.ratingSigmaBefore,
      muAfter: matchResults.ratingMuAfter,
      sigmaAfter: matchResults.ratingSigmaAfter,
      name: agents.name,
      color: agents.color,
    })
    .from(matchResults)
    .innerJoin(agents, eq(agents.id, matchResults.agentId))
    .where(eq(matchResults.matchId, matchId));

  const netOf = new Map(nets.map((entry) => [entry.agentId, entry]));

  const entrants: MatchEntrant[] = placed.length
    ? placed
        .map((entry) => ({
          agentId: entry.agentId,
          name: entry.name,
          color: entry.color,
          place: entry.place,
          finalStack: entry.finalStack,
          bustedAtHand: entry.bustedAtHand,
          ratingBefore: conservative({ mu: entry.muBefore, sigma: entry.sigmaBefore }),
          ratingAfter: conservative({ mu: entry.muAfter, sigma: entry.sigmaAfter }),
          net: netOf.get(entry.agentId)?.net ?? 0,
        }))
        .sort((a, b) => a.place - b.place)
    : nets
        .map((entry) => ({
          agentId: entry.agentId,
          name: entry.name,
          color: entry.color,
          place: null,
          finalStack: null,
          bustedAtHand: null,
          ratingBefore: null,
          ratingAfter: null,
          net: entry.net,
        }))
        .sort((a, b) => b.net - a.net);

  // Written by `settleMatch` in the same transaction that returned the chips,
  // so this is the record of what actually landed.
  let cashOut: number | null = null;
  let mine: string | null = null;
  if (viewerUserId) {
    const [entry] = await db
      .select({ delta: ledgerEntries.delta })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.userId, viewerUserId),
          eq(ledgerEntries.reference, matchId),
          eq(ledgerEntries.reason, 'match-cash-out'),
        ),
      )
      .limit(1);

    // One owner holds at most one seat in a match, so this is one agent at most.
    const owned = new Set(
      (await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, viewerUserId))).map((row) => row.id),
    );
    mine = entrants.find((entrant) => owned.has(entrant.agentId))?.agentId ?? null;
    cashOut = entry?.delta ?? (mine !== null && row.status !== 'playing' ? 0 : null);
  }

  return {
    matchId: row.id,
    number: row.number,
    status: row.status,
    seatCount: row.seatCount,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    buyIn: row.buyIn,
    entryFee: row.entryFee,
    handCap: row.handCap,
    handsPlayed: row.handsPlayed,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    entrants,
    mine,
    cashOut,
  };
}
