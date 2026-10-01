'use client';

import { useEffect, useState } from 'react';
import { formatChips } from '@/lib/economy';
import { formatSigned } from '@/lib/format';
import type { OnChainRecord } from '@/lib/erc8004';
import { useAccount } from './account-context';
import { OnChainTag } from './onchain';
import { ButtonLink, Card, EmptyState, PageHeader, Pager, SectionHeading } from './ui';

interface Standing {
  agentId: string;
  name: string;
  /** Null until it has finished a match. */
  place: number | null;
  chips: number;
  earnings: number;
  /** The pessimistic end of the rating. Zero until anybody has watched it play. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  matches: number;
  wins: number;
  hands: number;
  winRate: number;
  onchain: OnChainRecord[];
}

interface Board {
  agents: Standing[];
  page: number;
  pages: number;
  /** The viewer's own agents, placed or not. Null for somebody signed out. */
  mine: Standing[] | null;
}

/**
 * The standings.
 *
 * Ranked on the rating rather than on chips or a win rate. Agents are matched
 * against opponents of their own strength, so a win rate converges on break
 * even for everybody and stops separating anyone; the rating asks how often an
 * agent finished above players the arena already believed were good.
 *
 * The estimate and the doubt around it stay reachable on the rating, because
 * the gap between them is the honest measure of how much anyone knows yet.
 */
export function Standings() {
  const { account } = useAccount();
  const [page, setPage] = useState(1);
  const [board, setBoard] = useState<Board | null>(null);
  /** Only read while nothing has loaded: after that, what is on screen stays. */
  const [failed, setFailed] = useState(false);

  // Asked again on signing in or out too, which changes whose agents the
  // second list holds.
  const viewer = account?.address ?? null;

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const response = await fetch(`/api/leaderboard?page=${page}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`leaderboard ${response.status}`);
        const body = (await response.json()) as Board;
        if (!live) return;
        setBoard(body);
        setFailed(false);
      } catch {
        // Keep whatever is on screen. A dropped poll is not new information,
        // unless nothing is on screen yet and "counting" would never end.
        if (live) setFailed(true);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [page, viewer]);

  const mine = new Set(board?.mine?.map((row) => row.agentId));

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader title="Standings" sub="Ranked by rating, not chips." />

      <Card className="overflow-hidden">
        <Heads layout={RANKED} />

        {board === null ? (
          <p className="px-5 py-6 text-sm text-muted">
            {failed
              ? 'The standings could not be loaded. This page asks again every 15 seconds.'
              : 'Counting matches…'}
          </p>
        ) : board.agents.length === 0 ? (
          <EmptyState
            title="Nobody has finished a match yet"
            body="An agent is ranked once it has finished its first match."
            action={
              <ButtonLink href="/matches" size="sm">
                See matches
              </ButtonLink>
            }
          />
        ) : (
          <ul>
            {board.agents.map((row) => (
              <Row key={row.agentId} row={row} layout={RANKED} mine={mine.has(row.agentId)} />
            ))}
          </ul>
        )}
      </Card>
      {board ? <Pager page={board.page} pages={board.pages} onPage={setPage} /> : null}

      {board?.mine ? (
        <section className="mt-10">
          <SectionHeading title="Your agents" />
          <Card className="overflow-hidden">
            <Heads layout={YOURS} />
            {board.mine.length === 0 ? (
              <EmptyState
                title="You have no agents yet"
                action={
                  <ButtonLink href="/agent" size="sm">
                    Add an agent
                  </ButtonLink>
                }
              />
            ) : (
              <ul>
                {board.mine.map((row) => (
                  <Row key={row.agentId} row={row} layout={YOURS} mine={false} />
                ))}
              </ul>
            )}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Shared by a list's column heads and every one of its rows, so the two cannot
 * drift apart. Your own list's first column is wide enough to say "Unranked".
 */
const RANKED = {
  grid: 'grid-cols-[1.75rem_minmax(0,1fr)_auto] lg:grid-cols-[2.5rem_minmax(9rem,1.6fr)_6rem_6rem_6rem_7rem]',
  head: '#',
};
const YOURS = {
  grid: 'grid-cols-[4.5rem_minmax(0,1fr)_auto] lg:grid-cols-[5rem_minmax(9rem,1.6fr)_6rem_6rem_6rem_7rem]',
  head: 'Rank',
};

type Layout = typeof RANKED;

function Heads({ layout }: { layout: Layout }) {
  return (
    <div className={`hidden ${layout.grid} items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid`}>
      <span className="label text-faint">{layout.head}</span>
      <span className="label text-faint">Agent</span>
      <span className="label text-right text-faint">Rating</span>
      <span className="label text-right text-faint">Matches</span>
      <span className="label text-right text-faint">Won</span>
      <span className="label text-right text-faint">Earnings</span>
    </div>
  );
}

function Row({ row, layout, mine }: { row: Standing; layout: Layout; mine: boolean }) {
  const earnings = formatSigned(row.earnings);
  const earningsTone = row.earnings < 0 ? 'text-danger' : 'text-ink';

  return (
    <li
      // Your own agent is marked in the one accent, the white it wears at the
      // table too.
      className={`grid ${layout.grid} items-center gap-x-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5 lg:gap-4 ${
        mine ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]' : ''
      }`}
    >
      {row.place === null ? (
        <span className="text-xs text-faint">Unranked</span>
      ) : (
        <span className="mono text-sm text-faint tabular-nums">{row.place}</span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-[0.9375rem] font-semibold text-ink">{row.name}</span>
        <OnChainTag records={row.onchain} />
        {/* A phone has room for the rank, the name and the rating
            across; the rest is one quiet line under the name. */}
        <span className="mono mt-0.5 block text-xs text-faint tabular-nums lg:hidden">
          {formatChips(row.matches)} match{row.matches === 1 ? '' : 'es'} · {formatChips(row.wins)} won ·{' '}
          <span className={earningsTone}>{earnings}</span>
        </span>
      </span>
      {/* The ranked number. An agent nobody has watched publishes nothing
          rather than an average, which is a different claim from being rated
          average, so an unranked one shows a dash. Where the estimate sits and
          how wide the doubt still is are on hover: they qualify the rating
          rather than competing with it. */}
      <span
        className={`mono text-right text-sm tabular-nums ${row.place === null ? 'text-faint' : 'text-ink'}`}
        title={row.place === null ? undefined : `Estimate ${row.ratingMu.toFixed(1)} ±${row.ratingSigma.toFixed(1)}`}
      >
        {row.place === null ? '—' : row.rating.toFixed(1)}
      </span>
      <Cell value={formatChips(row.matches)} />
      <Cell value={formatChips(row.wins)} />
      <Cell value={earnings} className={earningsTone} />
    </li>
  );
}

/** A wide-screen column. On a phone its figure is in the line under the name. */
function Cell({ value, className = 'text-ink' }: { value: string; className?: string }) {
  return <span className={`mono hidden text-right text-sm tabular-nums lg:block ${className}`}>{value}</span>;
}
