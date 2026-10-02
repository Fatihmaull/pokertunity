import { CATEGORY, CATEGORY_NAMES, type Category } from '@/poker/evaluate';
import { PlayingCard } from './table-art';

/**
 * One example of every hand, strongest first. It leads with the cards that make
 * the hand and dims the rest, which only break a tie, so each row shows what
 * the hand is made of as well as naming it.
 */
const HANDS: ReadonlyArray<{ category: Category; cards: string; makes: number; says: string }> = [
  { category: CATEGORY.STRAIGHT_FLUSH, cards: 'Jh Th 9h 8h 7h', makes: 5, says: 'Five in a row, all one suit' },
  { category: CATEGORY.QUADS, cards: '9s 9h 9d 9c Kd', makes: 4, says: 'Four cards of one rank' },
  { category: CATEGORY.FULL_HOUSE, cards: 'Qs Qh Qd 4c 4s', makes: 5, says: 'Three of a kind plus a pair' },
  { category: CATEGORY.FLUSH, cards: 'Ad Jd 8d 6d 2d', makes: 5, says: 'Five cards of one suit' },
  { category: CATEGORY.STRAIGHT, cards: 'Ts 9h 8d 7c 6s', makes: 5, says: 'Five in a row' },
  { category: CATEGORY.TRIPS, cards: '7s 7h 7d Kc 2s', makes: 3, says: 'Three cards of one rank' },
  { category: CATEGORY.TWO_PAIR, cards: 'Js Jd 5h 5c As', makes: 4, says: 'Two different pairs' },
  { category: CATEGORY.PAIR, cards: 'Ac Ah Qs 8d 3c', makes: 2, says: 'Two cards of one rank' },
  { category: CATEGORY.HIGH_CARD, cards: 'As Jh 8d 5c 2s', makes: 1, says: 'None of the above' },
];

/**
 * The hand rankings, for a spectator still learning them. The names are the
 * evaluator's own, so a hand the log says was shown is listed here in the same
 * words.
 */
export function HandRankings() {
  return (
    <div className="scroll-y h-full p-3" data-panel-scroll tabIndex={0}>
      <p className="label px-1 pb-2 text-faint">Strongest first</p>
      <ol className="space-y-1">
        {HANDS.map((hand) => (
          <li
            key={hand.category}
            className="flex items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink first-letter:uppercase">{CATEGORY_NAMES[hand.category]}</p>
              <p className="text-xs text-faint">{hand.says}</p>
            </div>
            <div className="flex shrink-0 gap-0.5">
              {hand.cards.split(' ').map((card, index) => (
                <PlayingCard key={card} card={card} size={28} entrance="none" dimmed={index >= hand.makes} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
