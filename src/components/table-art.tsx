/* eslint-disable @next/next/no-img-element */
import { colorById } from '@/agent/colors';

/**
 * The physical objects on the felt. The cards and the seat marker are the actual
 * art from `public/cards` and `public/chips`.
 *
 * Money is deliberately shown as figures. At a table where the amount of a bet
 * is the whole story, the exact number is what matters, so stacks and bets live
 * in the arena beside the seat they belong to.
 *
 * These use plain `<img>` on purpose. The card and chip files are already small
 * fixed-size PNGs served from our own origin, already in their final form, so
 * plain tags serve them directly.
 */

const CARD_RATIO = 630 / 420;

/**
 * Where a card came from, as an offset in pixels from where it ends up.
 *
 * A seat hands back the vector to the middle of the table, so its cards are
 * dealt out of the middle, and the same vector run the other way is where the
 * hand goes when it is mucked. Anything else leaves it unset and keeps the
 * plain drop.
 */
export interface CardOrigin {
  x: number;
  y: number;
}

export interface CardMotion {
  delayMs?: number;
  origin?: CardOrigin | null;
  /**
   * `reveal` turns the card face up; `deal` slides it in from `origin`; `none`
   * draws it in place, for a card that illustrates a hand.
   */
  entrance?: 'deal' | 'reveal' | 'none';
  /** The hand is out of play and on its way back to the middle. */
  leaving?: boolean;
}

function motionClass({ entrance = 'deal', leaving = false }: CardMotion): string {
  if (leaving) return 'mucked';
  if (entrance === 'none') return '';
  return entrance === 'reveal' ? 'revealed' : 'dealt';
}

function motionStyle({ delayMs = 0, origin }: CardMotion): React.CSSProperties {
  // Custom properties sit outside React's CSS type, and casting here keeps
  // the two numbers in one prop for every caller.
  const style: Record<string, string> = { animationDelay: `${delayMs}ms` };
  if (origin) {
    style['--deal-x'] = `${Math.round(origin.x)}px`;
    style['--deal-y'] = `${Math.round(origin.y)}px`;
  }
  return style as React.CSSProperties;
}

export function PlayingCard({
  card,
  size = 84,
  dimmed = false,
  ...motion
}: CardMotion & {
  card: string;
  size?: number;
  dimmed?: boolean;
}) {
  return (
    <img
      src={`/cards/${card}.png`}
      alt={cardLabel(card)}
      width={size}
      height={Math.round(size * CARD_RATIO)}
      className={`${motionClass(motion)} block rounded-[6px] shadow-[0_10px_22px_-10px_rgba(0,0,0,0.85)]`}
      style={{ ...motionStyle(motion), opacity: dimmed ? 0.45 : 1 }}
      draggable={false}
    />
  );
}

export function CardBack({
  size = 84,
  dimmed = false,
  ...motion
}: CardMotion & { size?: number; dimmed?: boolean }) {
  return (
    <img
      src="/cards/back.png"
      alt="Face down"
      width={size}
      height={Math.round(size * CARD_RATIO)}
      className={`${motionClass(motion)} block rounded-[6px] shadow-[0_10px_22px_-10px_rgba(0,0,0,0.85)]`}
      style={{ ...motionStyle(motion), opacity: dimmed ? 0.4 : 1 }}
      draggable={false}
    />
  );
}

/**
 * A board position still waiting for its card. It marks the place quietly, so
 * the cards that fill it stay the loudest thing on the felt.
 */
export function CardSlot({ size = 84 }: { size?: number }) {
  return (
    <div
      className="rounded-[6px] bg-black/15"
      style={{ width: size, height: Math.round(size * CARD_RATIO) }}
      aria-hidden
    />
  );
}

/** The seat marker in the lobby and beside a name. One chip, seen from above. */
export function ChipDot({ color, size = 18, empty = false }: { color?: string | null; size?: number; empty?: boolean }) {
  if (empty || !color) {
    return (
      <span
        className="inline-block rounded-full border border-dashed border-white/25"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <img
      src={`/chips/${color}-top.png`}
      alt=""
      width={size}
      height={size}
      className="inline-block align-middle"
      draggable={false}
    />
  );
}

export function DealerButton({ size = 22 }: { size?: number }) {
  return <img src="/chips/dealer-top.png" alt="Dealer" width={size} height={size} draggable={false} />;
}

/** Falls back to the interface accent, so an unowned seat still looks deliberate. */
export function agentHex(color: string | null | undefined): string {
  return color ? colorById(color).hex : '#fafafa';
}

const RANK_WORDS: Record<string, string> = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  T: 'Ten',
};

const SUIT_WORDS: Record<string, string> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

function cardLabel(card: string): string {
  const rank = RANK_WORDS[card[0]] ?? card[0];
  return `${rank} of ${SUIT_WORDS[card[1]] ?? card[1]}`;
}
