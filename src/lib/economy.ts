/**
 * Chips are the unit of play. They are a fixed peg on the native token of
 * whichever chain a deposit settled on: one chip is always worth 0.00001 of
 * it, in both directions. All balances and pots are integer chip counts, so pot
 * arithmetic stays in whole numbers, apart from floats and wei.
 *
 * The peg is deliberately the same number on every chain. Test tokens trade
 * separately from each other, so one peg everywhere keeps a pot meaning the
 * same thing on every network.
 */

/** Wei backing a single chip. 0.00001 of the chain's native token. */
export const WEI_PER_CHIP = 10_000_000_000_000n;

export function chipsToWei(chips: number): bigint {
  if (!Number.isInteger(chips) || chips < 0) throw new Error(`not a chip amount: ${chips}`);
  return BigInt(chips) * WEI_PER_CHIP;
}

/** Rounds down to whole chips. */
export function weiToChips(wei: bigint): number {
  if (wei < 0n) throw new Error('negative wei');
  return Number(wei / WEI_PER_CHIP);
}

/**
 * The fewest chips one purchase buys. The vault refuses a deposit under 0.01
 * of the native token (`VAULT_MIN_DEPOSIT_WEI` when it is deployed), which is
 * this many chips.
 */
export const MIN_PURCHASE = 1_000;

/**
 * The most one purchase buys: ten of the native token. Balances are a 32-bit
 * integer column, and this keeps any one purchase far inside it.
 */
export const MAX_PURCHASE = 1_000_000;

/** Null when the cashier sells this many chips; otherwise the sentence saying what it sells. */
export function purchaseRefusal(chips: number): string | null {
  if (Number.isInteger(chips) && chips >= MIN_PURCHASE && chips <= MAX_PURCHASE) return null;
  return `Buy between ${formatChips(MIN_PURCHASE)} and ${formatChips(MAX_PURCHASE)} chips.`;
}

/** Display helpers. Formatting lives here so chips read the same on every screen. */
export function formatChips(chips: number): string {
  return chips.toLocaleString('en-US');
}

/**
 * Wei as a decimal amount of the native token, for the caller to put a symbol
 * after. Five places, because a chip is the fifth: any chip count prints exactly.
 */
export function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 5).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * The match.
 *
 * Every game in the arena is the same game: one blind level, one buy-in, the
 * same seats, the same length. One stake fills from a field this size, and it
 * keeps every agent in the same company, so a well-funded agent has to earn its
 * rating against the same opponents as everybody else.
 */

/** Six-handed is where multiway pots live, which is where reading an opponent pays. */
export const MAX_SEATS = 6;

/**
 * Two is a game.
 *
 * A match would rather start short than wait, because a played match teaches
 * something. The matchmaker holds briefly for a full table first.
 */
export const MIN_SEATS = 2;

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;

/**
 * How deep everyone sits, in big blinds.
 *
 * Deep enough that hands play past the flop, where reading an opponent actually
 * happens. Short-stacked poker collapses into a preflop shoving game, which is
 * the one part of hold'em that is already solved and the least interesting
 * thing an agent could be tested on.
 */
export const BUY_IN_BB = 100;
export const BUY_IN = BIG_BLIND * BUY_IN_BB;

/**
 * The house's cut, charged once at the door.
 *
 * Tournaments charge a fee to enter and leave every pot whole, which is the
 * right model here. A fee is the same for everybody, so it shifts every result
 * by the same amount and keeps the order intact. It is also how chips leave
 * the arena, which keeps the supply in balance.
 */
export const ENTRY_FEE_BPS = 200;
export const ENTRY_FEE = Math.floor((BUY_IN * ENTRY_FEE_BPS) / 10_000);

/** What one seat costs an owner, all in. */
export const SEAT_COST = BUY_IN + ENTRY_FEE;

/**
 * How long a match runs when the field survives.
 *
 * Blinds stay level, so the cap is what ends it. A hundred hands costs each
 * agent around twenty-five big blinds in blinds alone, which is enough pressure
 * to punish folding and keeps the endgame a game of poker. Shorter
 * matches also mean more finishing orders, and a rating converges on the number
 * of results.
 *
 * Overridable because a hundred hands is roughly eighty minutes once pacing is
 * counted, and a public arena wants matches a visitor can watch reach an end. A
 * match stores the cap it was played under, so every recorded result keeps its
 * own cap.
 */
export const DEFAULT_HAND_CAP = 100;

/**
 * Reads the override, accepting a positive hand count.
 *
 * `Number('')` is zero and `Number('thirty')` is NaN, and a bare `??` lets both
 * through: the first ends every match before a card is dealt, the second means
 * the cap never arrives and a table runs until somebody busts. Both look like a
 * working arena from outside, so an unusable value plays the default and says
 * so.
 */
export function handCapFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HAND_CAP;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`HAND_CAP needs a positive hand count, got ${JSON.stringify(raw)}. Playing ${DEFAULT_HAND_CAP}.`);
    return DEFAULT_HAND_CAP;
  }

  return parsed;
}

export const HAND_CAP = handCapFrom(process.env.HAND_CAP);

/**
 * What a new account starts with.
 *
 * An owner gets to find out whether the thing works before paying anything.
 * This is four seats outright, and a fifth as soon as any buy-in comes back, which is enough
 * to see whether an agent is hopeless. After that, chips come from the cashier.
 *
 * A round figure, so it reads as a sum an owner was given.
 */
export const STARTING_GRANT = 10_000;

export interface MatchConfig {
  seats: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  entryFee: number;
  handCap: number;
}

/** The one game on offer, as the engine and the screens both need it. */
export const MATCH: MatchConfig = {
  seats: MAX_SEATS,
  smallBlind: SMALL_BLIND,
  bigBlind: BIG_BLIND,
  buyIn: BUY_IN,
  entryFee: ENTRY_FEE,
  handCap: HAND_CAP,
};

