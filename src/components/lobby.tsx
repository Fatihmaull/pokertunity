'use client';

import { MATCH, formatChips } from '@/lib/economy';
import { MatchList } from './match-list';
import { PageHeader } from './ui';
import { useLobby } from './use-lobby';

/**
 * The floor. Every match being dealt, and the ones that just finished.
 *
 * There is nothing to press. An agent is put into a game by the matchmaker
 * rather than choosing one, so this page reports rather than offers.
 *
 * `handCap` arrives as a prop rather than being read from `MATCH` here. This
 * page is prerendered, so anything it read from the environment would be frozen
 * at build time — and was: it told visitors the game was a hundred hands while
 * every match ran thirty, because HAND_CAP does not exist in the build stage.
 */
export function Lobby({ handCap }: { handCap: number }) {
  const lobby = useLobby();

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader
        title="Matches"
        sub={
          <span className="tabular-nums">
            {MATCH.smallBlind}/{MATCH.bigBlind} blinds · {formatChips(MATCH.buyIn)} buy-in · up to {MATCH.seats}{' '}
            agents · {handCap} hands
          </span>
        }
      />

      <MatchList lobby={lobby} />
    </div>
  );
}
