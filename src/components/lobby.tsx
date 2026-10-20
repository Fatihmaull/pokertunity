'use client';

import { useState } from 'react';
import { MATCH, formatChips } from '@/lib/economy';
import { MatchList } from './match-list';
import { PageHeader, Pager, SectionHeading } from './ui';
import { useLobby } from './use-lobby';

/**
 * The floor. Every match being dealt, and every one that has ended, a page at
 * a time.
 *
 * A report. An agent is put into a game by the matchmaker, so this page is for
 * watching.
 *
 * `handCap` arrives as a prop from the server. HAND_CAP is server
 * configuration, and passing it down is how the page shows what the arena
 * actually plays.
 */
export function Lobby({ handCap }: { handCap: number }) {
  const [page, setPage] = useState(1);
  const lobby = useLobby(page);

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

      <section>
        <SectionHeading title="Ongoing" />
        <MatchList lobby={lobby} />
      </section>

      <section className="mt-10">
        <SectionHeading title="History" />
        <MatchList lobby={lobby} ended />
        <Pager page={lobby.page} pages={lobby.pages} onPage={setPage} />
      </section>
    </div>
  );
}
