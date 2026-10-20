import type { ActFrame, DecisionFrame, OpponentSeat, Street } from '@pokertunity/protocol';
import type { Action, HandState, LegalActions } from '../poker/engine';
import { legalActions, totalPot } from '../poker/engine';
import { cardName } from '../poker/cards';
import { type Equity, type HandRead, equityVsRandom, readHand } from '../poker/equity';
import { wait } from '../lib/wait';
import { type AgentDecision, type DecisionOutcome, defaultAction, validateDecision } from './decision';

/**
 * One seat's turn.
 *
 * The arena settles three things before it asks anybody anything: what the hand
 * actually is, what it is worth, and which moves are legal. The agent chooses
 * among legal moves and explains itself. The arena computes the equity that
 * gets published and decides what is allowed.
 *
 * Everything from the far end is checked. An answer that is late, malformed,
 * outside the legal set, or absent because the socket died all arrive at the
 * same place: the seat checks when checking is free and folds when it costs
 * chips, and that is recorded as a timeout or an error. An agent that walked
 * away and an agent that chose to fold are different events, and the record
 * keeps them apart.
 */

/** The narrow slice of a connection this needs. Anything that can answer will do. */
export interface Askable {
  ask(
    frame: ActFrame,
    onReasoning: (text: string) => void,
    signal: AbortSignal,
  ): Promise<DecisionFrame | null>;
}

export interface DecideOptions {
  /**
   * The open connection to this agent, resolved on demand.
   *
   * A function because a socket can drop and come back inside one decision, and
   * the connection that returns is a different object from the one that left.
   * Resolving it fresh means a two-second network blip costs the agent nothing.
   */
  link: () => Askable | null;
  state: HandState;
  seatIndex: number;
  /** Hard ceiling on the act clock. Expiry checks or folds. */
  clockMs: number;
  matchId: string;
  handNumber: number;
  /**
   * The chair each engine position is sitting in.
   *
   * The engine numbers the players in a hand densely from zero and renumbers
   * them as agents bust out. An agent needs a number that means the same thing
   * all match, so everything that crosses the wire is a chair and this is the
   * one place the two are reconciled.
   */
  chairs: readonly number[];
  /**
   * Display name for each agent id at the table. Opponents read as the names
   * their owners gave them, which tells an agent who it faces and keeps internal
   * identifiers on the server.
   */
  opponentNames?: ReadonlyMap<string, string>;
  /** How long each chair's last decision took, which is public at a real table. */
  opponentTiming?: ReadonlyMap<number, number>;
  equitySamples?: number;
  /** Called as reasoning arrives, so the Brain Visualizer can show it streaming. */
  onToken?: (text: string) => void;
  /** Called once the simulation finishes, before the agent is asked anything. */
  onEquity?: (equity: Equity, read: HandRead) => void;
  signal?: AbortSignal;
}

export interface DecisionRecord extends AgentDecision {
  equity: Equity;
  read: HandRead;
  outcome: DecisionOutcome;
  elapsedMs: number;
  /** Plain statement of what went wrong, or null when all went well. */
  failure: string | null;
}

const POSITIONS_BY_SEATS: Record<number, string[]> = {
  2: ['button', 'big blind'],
  3: ['button', 'small blind', 'big blind'],
  4: ['button', 'small blind', 'big blind', 'cutoff'],
  5: ['button', 'small blind', 'big blind', 'middle', 'cutoff'],
  6: ['button', 'small blind', 'big blind', 'under the gun', 'middle', 'cutoff'],
};

export function positionName(state: HandState, seatIndex: number): string {
  const live = state.seats.filter((seat) => !seat.sittingOut).length;
  const names = POSITIONS_BY_SEATS[live] ?? POSITIONS_BY_SEATS[6];
  const offset = (seatIndex - state.button + state.seats.length) % state.seats.length;
  return names[offset] ?? `seat ${seatIndex + 1}`;
}

export async function decide(options: DecideOptions): Promise<DecisionRecord> {
  const { state, seatIndex, clockMs, link, chairs } = options;
  const chairOf = (position: number) => chairs[position] ?? position;
  const started = Date.now();
  const seat = state.seats[seatIndex];
  const legal = legalActions(state);

  if (!legal || !seat.hole) throw new Error(`seat ${seatIndex} is not to act`);

  const liveOpponents = state.seats.filter(
    (other) => other.index !== seatIndex && !other.folded && !other.sittingOut,
  );
  const equity = equityVsRandom(
    seat.hole,
    state.board,
    Math.max(1, liveOpponents.length),
    options.equitySamples ?? sampleCount(state.board.length),
  );
  const read = readHand(seat.hole, state.board);
  options.onEquity?.(equity, read);

  const forced = forcedMove(legal, equity);
  if (forced) {
    return {
      ...forced,
      equity,
      read,
      outcome: 'decided',
      elapsedMs: Date.now() - started,
      failure: null,
    };
  }

  // A missing socket means the agent is away. It keeps its chips and its seat
  // until the match ends, so it plays out as a seat that checks or folds.
  if (!link()) {
    return {
      action: defaultAction(legal),
      reasoning: '',
      say: null,
      equity,
      read,
      outcome: 'error',
      elapsedMs: Date.now() - started,
      failure: 'disconnected',
    };
  }

  const frame: ActFrame = {
    type: 'act',
    id: `${options.matchId}:${options.handNumber}:${seatIndex}:${state.events.length}`,
    matchId: options.matchId,
    handNumber: options.handNumber,
    street: state.street as Street,
    seat: chairOf(seatIndex),
    button: chairOf(state.button),
    position: positionName(state, seatIndex),
    hole: [cardName(seat.hole[0]), cardName(seat.hole[1])],
    board: state.board.map(cardName),
    stack: seat.stack,
    committed: seat.committed,
    potSize: totalPot(state),
    legal,
    equity,
    read: {
      made: read.made,
      flushDraw: read.flushDraw,
      openEnded: read.openEnded,
      gutshot: read.gutshot,
      overcards: read.overcards,
    },
    opponents: describeOpponents(
      state,
      seatIndex,
      chairOf,
      options.opponentNames ?? new Map(),
      options.opponentTiming ?? new Map(),
    ),
    remainingMs: clockMs,
  };

  const clock = new AbortController();
  // The clock starts here: the equity simulation above runs before anybody is
  // asked anything, so the agent's clock covers its own thinking alone.
  const clockStartedAt = Date.now();
  const timer = setTimeout(() => clock.abort(), clockMs);
  const signal = options.signal ? AbortSignal.any([options.signal, clock.signal]) : clock.signal;

  let reasoning = '';
  const hear = (text: string) => {
    reasoning += text;
    options.onToken?.(text);
  };

  let reply: DecisionFrame | null = null;
  try {
    // Asked at most twice. A null answer with time still on the clock means the
    // socket went away, so the agent is given a moment to come back and is asked
    // again on whatever connection returns. After that the seat acts by the
    // fallback rule, because the table keeps moving.
    for (let attempt = 0; attempt < 2 && !clock.signal.aborted; attempt++) {
      const open = link();
      if (!open) {
        if (attempt === 0) break;
        continue;
      }

      // A second attempt reports the clock it actually has, so an agent budgets
      // against the time truly left after the reconnect. The id stays the same:
      // it is the same question, asked again because the connection changed.
      reply = await open.ask(
        attempt === 0 ? frame : { ...frame, remainingMs: remaining(clockStartedAt, clockMs) },
        hear,
        signal,
      );
      if (reply || clock.signal.aborted) break;

      await grace(RECONNECT_GRACE_MS, signal);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!reply) {
    const timedOut = clock.signal.aborted;
    return {
      action: defaultAction(legal),
      reasoning,
      say: null,
      equity,
      read,
      outcome: timedOut ? 'timeout' : 'error',
      elapsedMs: Date.now() - started,
      failure: timedOut ? 'ran out of time' : 'sent an unusable answer',
    };
  }

  // Reasoning arrives as a stream and the decision arrives as a frame, so the
  // two are stitched here, so an agent says each thing once.
  const decision = validateDecision({ ...reply, reasoning }, legal);
  if (!decision) {
    return {
      action: defaultAction(legal),
      reasoning,
      say: null,
      equity,
      read,
      outcome: 'error',
      elapsedMs: Date.now() - started,
      failure: `asked for ${reply.action}, outside the legal moves`,
    };
  }

  return {
    ...decision,
    equity,
    read,
    outcome: 'decided',
    elapsedMs: Date.now() - started,
    failure: null,
  };
}

/**
 * Guards for spots that take zero judgement: a forced move, or a call that
 * loses on every runout.
 *
 * Both are rare in practice. Hold'em almost always leaves at least two options,
 * and a hand with literally zero equity against a random holding is close to
 * unreachable, so this is a correctness guard.
 */
function forcedMove(legal: LegalActions, equity: Equity): AgentDecision | null {
  const options: Action[] = [];
  if (legal.fold) options.push({ type: 'fold' });
  if (legal.check) options.push({ type: 'check' });
  if (legal.call !== null) options.push({ type: 'call' });
  if (legal.bet) options.push({ type: 'bet' });
  if (legal.raise) options.push({ type: 'raise' });

  if (options.length === 1) {
    return { action: options[0], reasoning: 'No other move was available.', say: null };
  }

  if (legal.toCall > 0 && equity.win === 0 && equity.tie === 0) {
    return { action: { type: 'fold' }, reasoning: 'Drawing dead. No runout wins this pot.', say: null };
  }

  return null;
}

/**
 * How long a dropped socket is given to come back mid-decision.
 *
 * Short enough that a genuinely absent agent barely slows the table, long
 * enough to cover the reconnect a flaky network causes. The act clock is still
 * the outer bound; this decides how much of it is spent waiting.
 */
const RECONNECT_GRACE_MS = 750;

function remaining(startedAt: number, clockMs: number): number {
  return Math.max(0, clockMs - (Date.now() - startedAt));
}

function grace(ms: number, signal: AbortSignal): Promise<void> {
  return wait(ms, signal);
}

/** More samples early, when there is more still to come and the number matters most. */
function sampleCount(boardSize: number): number {
  if (boardSize === 0) return 3000;
  if (boardSize === 3) return 2500;
  if (boardSize === 4) return 2000;
  return 1000;
}

function describeOpponents(
  state: HandState,
  seatIndex: number,
  chairOf: (position: number) => number,
  names: ReadonlyMap<string, string>,
  timing: ReadonlyMap<number, number>,
): OpponentSeat[] {
  const lastAction = new Map<number, string>();
  for (const event of state.events) {
    if (event.type === 'action') lastAction.set(event.seat, event.action);
  }

  return state.seats
    .filter((seat) => seat.index !== seatIndex && !seat.sittingOut)
    .map((seat) => ({
      seat: chairOf(seat.index),
      name: names.get(seat.agentId) ?? seat.agentId,
      stack: seat.stack,
      committed: seat.committed,
      status: seat.folded ? 'folded' : seat.allIn ? 'all-in' : 'in',
      lastAction: lastAction.get(seat.index) ?? null,
      // How long a seat took is public at a real table. Why it took that long
      // stays private, on the server.
      lastActionMs: timing.get(chairOf(seat.index)) ?? null,
    }));
}
