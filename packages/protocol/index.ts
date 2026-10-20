/**
 * The wire between the arena and an agent.
 *
 * Both sides import this file, so a change to a frame fails to compile in two
 * places, at build time. That is the whole reason it is a shared package.
 *
 * Two rules hold everywhere below. The arena is the authority: it settles what
 * a hand is worth and which moves are legal before it asks anything, and it
 * checks whatever comes back. And the arena enforces every bound here itself,
 * whatever the agent on the other end does.
 */

/**
 * Bumped when a frame changes shape in a way an older agent would misread.
 *
 * The arena refuses a version outside what it serves and says so in the close
 * reason. Failing at startup costs the author a restart; a half-understood
 * protocol would cost them a tournament.
 */
export const PROTOCOL_VERSION = 1;

/** Path the agent socket lives on. Everything else on the port is the website. */
export const SOCKET_PATH = '/agent';

/** Largest single frame either side will accept, in bytes of UTF-8. */
export const MAX_FRAME_BYTES = 8_192;

/** Total reasoning one decision may stream, in bytes. The panel shows far less. */
export const MAX_REASONING_BYTES = 4_096;

/**
 * Frames per second one connection may send before it is closed.
 *
 * Loose on purpose. The reasoning budget below is what actually bounds the
 * volume an agent can push; this is a coarse net for a client stuck in a loop.
 * Kept loose, it lets an agent forward a model's token stream frame by frame,
 * which is a reasonable thing to write.
 */
export const MAX_FRAMES_PER_SECOND = 200;

/**
 * Why the arena hung up.
 *
 * Every close carries one of these plus a sentence, because an agent author
 * debugging at two in the morning deserves to be told what they did.
 */
export const CLOSE = {
  /** Handshake arrived late, malformed, or missing. */
  BAD_HANDSHAKE: 4000,
  /** Token unknown, revoked, or matching zero agents. */
  UNAUTHORIZED: 4001,
  /** Protocol version outside what this arena serves. */
  VERSION: 4002,
  /** Frame rate, frame size, or reasoning budget exceeded. */
  FLOODING: 4003,
  /** Invalid JSON, or a frame type this arena does not know. */
  MALFORMED: 4004,
  /** Same agent connected somewhere else, and the newer connection wins. */
  REPLACED: 4005,
  /** Arena is shutting down. Reconnecting later is the right response. */
  GOING_AWAY: 4006,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * What this seat may legally do, already computed.
 *
 * The arena works all of this out, and it is final. A reply outside these
 * bounds is either clamped into range or discarded, and a discarded reply checks
 * when checking is free and folds when it costs chips.
 */
export interface LegalActions {
  fold: boolean;
  check: boolean;
  /** Chips to call, or null when this seat has matched the bet. */
  call: number | null;
  /** Opening bet range, while the round is unopened. */
  bet: { min: number; max: number } | null;
  /** Raise range, as the total to have in front of you when done. */
  raise: { min: number; max: number } | null;
  toCall: number;
  potSize: number;
}

/**
 * The arena's own Monte Carlo estimate for this hand against random holdings.
 *
 * Sent so that agents are comparable and everybody starts from a sound Monte
 * Carlo. An agent is free to compute its own.
 */
export interface EquityView {
  /** Share of the pot this hand expects, ties counted as half. */
  equity: number;
  win: number;
  tie: number;
  lose: number;
  samples: number;
}

/** What the hand actually is, and what it is drawing to. */
export interface HandReadView {
  made: string;
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  overcards: boolean;
}

/**
 * Another seat, as this agent is entitled to see it.
 *
 * Hole cards stay hidden until a showdown puts them in a hand result. How long a
 * seat took is included because it is public at a real table; the reason stays
 * private.
 */
export interface OpponentSeat {
  seat: number;
  name: string;
  stack: number;
  /** Chips in front of them this betting round. */
  committed: number;
  status: 'in' | 'folded' | 'all-in';
  lastAction: string | null;
  lastActionMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Arena to agent                                                             */
/* -------------------------------------------------------------------------- */

/** The handshake was accepted. The agent sends `ready` when it wants a game. */
export interface WelcomeFrame {
  type: 'welcome';
  version: number;
  agentId: string;
  name: string;
  /** Chips the owner has, so an agent can tell why it is waiting. */
  chips: number;
  /** What one seat costs, buy-in and entry fee together. */
  seatCost: number;
}

/** The queue answer. Sent whenever it changes, including on refusal. */
export interface QueueFrame {
  type: 'queued';
  queued: boolean;
  /** Present when queued is false and the agent asked to be. */
  reason: string | null;
}

/**
 * Seated. The field is fixed from here to the end of the match, so this arrives
 * once and describes the whole match.
 */
export interface MatchStartFrame {
  type: 'match-start';
  matchId: string;
  /** This agent's chair. Chairs are dense at the start and go sparse as agents bust. */
  seat: number;
  seats: Array<{ seat: number; name: string; stack: number }>;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
}

/**
 * Your turn.
 *
 * Echo `id` on the reply. A reply carrying any other id is treated as a silent
 * seat, which matters because agents that time out and answer a
 * second late are ordinary.
 */
export interface ActFrame {
  type: 'act';
  id: string;
  matchId: string;
  handNumber: number;
  street: Street;
  seat: number;
  button: number;
  /** Position name at this table size, for an agent that reasons in those terms. */
  position: string;
  hole: [string, string];
  board: string[];
  stack: number;
  /** Chips this seat has already put in during this betting round. */
  committed: number;
  potSize: number;
  legal: LegalActions;
  equity: EquityView;
  read: HandReadView;
  opponents: OpponentSeat[];
  /** Milliseconds left on the act clock, so an agent can budget its own thinking. */
  remainingMs: number;
}

/**
 * How the hand ended, from this agent's side of the table.
 *
 * `shown` carries the holdings that were actually turned face up. The arena
 * mucks what a real table mucks, so a hand somebody threw away face down stays
 * face down here too.
 */
export interface HandResultFrame {
  type: 'hand-result';
  matchId: string;
  handNumber: number;
  board: string[];
  /** Chips this agent won or lost on the hand. */
  net: number;
  /** Its stack once the pot was pushed. */
  stack: number;
  showdown: boolean;
  shown: Array<{ seat: number; name: string; hole: [string, string] }>;
  winners: Array<{ seat: number; name: string; amount: number }>;
}

/** The match is over and the chips have gone back. The socket stays open. */
export interface MatchEndFrame {
  type: 'match-end';
  matchId: string;
  ending: 'elimination' | 'cap' | 'abandoned';
  handsPlayed: number;
  /** Finishing position, one being first. Null for an abandoned match. */
  place: number | null;
  entrants: number;
  finalStack: number;
  /** Published rating before and after, so an agent can see what the result cost it. */
  rating: { before: number; after: number } | null;
}

/** Something went wrong. Fatal errors are followed immediately by a close. */
export interface ErrorFrame {
  type: 'error';
  code: CloseCode | null;
  message: string;
}

export type ServerFrame =
  | WelcomeFrame
  | QueueFrame
  | MatchStartFrame
  | ActFrame
  | HandResultFrame
  | MatchEndFrame
  | ErrorFrame;

/* -------------------------------------------------------------------------- */
/* Agent to arena                                                             */
/* -------------------------------------------------------------------------- */

/** First frame on every connection; any other frame first closes the socket. */
export interface HelloFrame {
  type: 'hello';
  version: number;
  token: string;
}

/**
 * Put me in the queue.
 *
 * Separate from connecting on purpose: an agent connects to a live arena and
 * stays unseated until it asks, which is what lets anybody debug against
 * production.
 */
export interface ReadyFrame {
  type: 'ready';
}

/**
 * Take me out of the queue.
 *
 * Every seat plays its match to the end, so this applies to the next one.
 */
export interface StopFrame {
  type: 'stop';
}

/**
 * Thinking out loud, as it happens.
 *
 * Optional in every sense: an agent plays the same either way, and what
 * it streams is free to wander from what it decides.
 * Spectators see these live.
 */
export interface ReasoningFrame {
  type: 'reasoning';
  /** The act frame this belongs to. */
  id: string;
  text: string;
}

/**
 * The move.
 *
 * One per act frame; the first one counts. `to` is the total to
 * have in front of you for a bet or a raise, matching the bounds in `legal`.
 */
export interface DecisionFrame {
  type: 'decision';
  id: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  to?: number;
  /** One short line of table talk, shown to spectators. */
  say?: string;
}

/** Keeps a quiet connection alive through proxies that time out idle sockets. */
export interface PingFrame {
  type: 'ping';
}

export type ClientFrame = HelloFrame | ReadyFrame | StopFrame | ReasoningFrame | DecisionFrame | PingFrame;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads a frame off the wire, checking every field.
 *
 * Returns null for a malformed frame, because on a public socket that is an
 * expected event. What makes a frame *legal* is decided against the hand; this
 * settles whether it is a frame.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;

  switch (frame.type) {
    case 'hello':
      return typeof frame.version === 'number' && typeof frame.token === 'string'
        ? { type: 'hello', version: frame.version, token: frame.token }
        : null;
    case 'ready':
      return { type: 'ready' };
    case 'stop':
      return { type: 'stop' };
    case 'ping':
      return { type: 'ping' };
    case 'reasoning':
      return typeof frame.id === 'string' && typeof frame.text === 'string'
        ? { type: 'reasoning', id: frame.id, text: frame.text }
        : null;
    case 'decision': {
      if (typeof frame.id !== 'string' || typeof frame.action !== 'string') return null;
      const decision: DecisionFrame = {
        type: 'decision',
        id: frame.id,
        // Checked against the legal set by the arena, against the hand itself.
        action: frame.action as DecisionFrame['action'],
      };
      if (typeof frame.to === 'number') decision.to = frame.to;
      if (typeof frame.say === 'string') decision.say = frame.say;
      return decision;
    }
    default:
      return null;
  }
}

/** The mirror of the above, for an agent reading what the arena sent. */
export function parseServerFrame(raw: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const frame = value as { type?: unknown };
  return typeof frame.type === 'string' ? (value as ServerFrame) : null;
}
