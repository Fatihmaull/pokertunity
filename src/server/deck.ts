import { randomInt } from 'node:crypto';
import { fullDeck, type Card } from '../poker/cards';

/**
 * A fresh deck, in an order beyond reconstruction at the table.
 *
 * Shuffled from the operating system's CSPRNG. A seed is a secret small enough to search: every seat is shown its
 * own hole cards and then the board, and a 31-bit seed that also has to produce
 * those cards is pinned down within seconds. Whoever finds it holds every
 * opponent's hand and the rest of the runout. A CSPRNG deck leaves nothing to
 * search for.
 *
 * Replay deals from the stored order. The order is stored with the hand, which
 * is the thing a replay actually deals from.
 */
export function shuffledDeck(): Card[] {
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
