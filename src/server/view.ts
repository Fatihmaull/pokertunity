import type { Street } from '../poker/engine';

/**
 * What a spectator is allowed to know. Hole cards are omitted unless they
 * belong to the viewer's own agent or have been shown at a real showdown, so
 * redaction happens on the server and never in the browser.
 */

export type SeatStatus = 'empty' | 'waiting' | 'thinking' | 'acted' | 'folded' | 'all-in';

export interface SeatView {
  index: number;
  agentId: string | null;
  name: string | null;
  /** Chip colour id from the asset palette. */
  color: string | null;
  stack: number;
  committed: number;
  status: SeatStatus;
  isDealer: boolean;
  /** Present only when this viewer is entitled to see them. */
  hole: string[] | null;
  lastAction: string | null;
  /** The level the last action put this seat at. */
  lastActionTo: number | null;
  /** Chips won this hand, held until the next one is dealt. */
  won: number | null;
  /** The blind this seat was made to post, until it acts of its own accord. */
  blind: { kind: 'small' | 'big'; amount: number } | null;
  say: string | null;
}

export interface BrainView {
  seat: number;
  /** Carried here rather than looked up, because a seat can empty between hands. */
  seatName: string | null;
  color: string | null;
  street: Street;
  /** Reasoning as it has arrived so far. */
  reasoning: string;
  equity: number | null;
  handRead: {
    made: string;
    flushDraw: boolean;
    openEnded: boolean;
    gutshot: boolean;
    overcards: boolean;
  } | null;
  potOdds: number | null;
  action: string | null;
  amount: number | null;
  /** Plain statement of what went wrong, or null when nothing did. */
  failure: string | null;
  elapsedMs: number | null;
  /**
   * True while the reasoning, equity and hand read above are withheld.
   *
   * They are the holding by another name: an equity of 0.9 on the river names
   * the cards as surely as turning them over would. So they stay sealed for the
   * whole hand and open only for seats that show at a showdown, the same rule
   * the replay applies afterwards. The seat's own owner gets the sealed view
   * too, because the feed is public and one rule is the only kind that cannot
   * be walked around.
   */
  sealed: boolean;
}

export interface TableView {
  matchId: string;
  label: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  handCap: number;
  handNumber: number;
  street: Street | 'idle';
  board: string[];
  pot: number;
  seats: SeatView[];
  toAct: number | null;
  /** Epoch milliseconds the act clock expires, if a seat is thinking. */
  deadline: number | null;
  /**
   * Milliseconds left on the act clock when this was rendered. The viewer's
   * clock is not the server's, so a countdown reads this and runs against its
   * own clock rather than subtracting a foreign epoch.
   */
  remainingMs: number | null;
  brain: BrainView | null;
  log: LogLine[];
}

export interface LogLine {
  id: number;
  at: number;
  text: string;
}

export type ArenaEvent =
  | { type: 'snapshot'; table: TableView }
  | { type: 'hand-start'; handNumber: number; button: number; seats: SeatView[] }
  | {
      type: 'to-act';
      seat: number;
      seatName: string;
      color: string;
      /** Milliseconds on the clock, counted down against the viewer's own. */
      remainingMs: number;
      potOdds: number | null;
      street: Street;
    }
  // No event carries a deciding seat's reasoning, equity or hand read while its
  // hand is live. See `BrainView.sealed`; `reveal` is the only way they leave.
  | {
      type: 'decision';
      seat: number;
      action: string;
      amount: number;
      to: number;
      failure: string | null;
      elapsedMs: number;
      say: string | null;
      stack: number;
      committed: number;
      pot: number;
    }
  /** A seat that showed at showdown, with the thinking behind its last decision. */
  | { type: 'reveal'; brain: BrainView }
  | { type: 'street'; street: Street; cards: string[]; pot: number }
  | { type: 'showdown'; seat: number; hole: string[] }
  | { type: 'award'; seat: number; amount: number; stack: number }
  | { type: 'hand-end'; stacks: Array<{ seat: number; stack: number }> }
  | { type: 'seats'; seats: SeatView[] }
  | { type: 'log'; line: LogLine }
  | { type: 'idle'; reason: string };
