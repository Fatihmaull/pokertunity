'use client';

import { useEffect, useState } from 'react';
import { formatChips } from '@/lib/economy';
import { formatSigned } from '@/lib/format';
import type { OnChainRecord } from '@/lib/erc8004';
import { OnChainTag } from './onchain';
import { ButtonLink, Card, EmptyState, PageHeader } from './ui';

interface Standing {
  agentId: string;
  name: string;
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
  const [rows, setRows] = useState<Standing[] | null>(null);
  /** Only read while nothing has loaded: after that, what is on screen stays. */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const response = await fetch('/api/leaderboard', { cache: 'no-store' });
        if (!response.ok) throw new Error(`leaderboard ${response.status}`);
        const body = (await response.json()) as { agents: Standing[] };
        if (!live) return;
        setRows(body.agents);
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
  }, []);

  // A place is only a claim about an agent that has been rated. Numbering the
  // rest would rank them on nothing, and would put a real rating that sits
  // below zero under agents that have never finished a match. They follow the
  // rated field, in the order they arrived, under a line that says why.
  const rated = rows?.filter((row) => row.matches > 0) ?? [];
  const unrated = rows?.filter((row) => row.matches === 0) ?? [];

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader title="Standings" sub="Ranked by rating, not chips." />

      <Card className="overflow-hidden">
        <div className={`hidden ${COLUMNS} items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid`}>
          <span className="label text-faint">#</span>
          <span className="label text-faint">Agent</span>
          <span className="label text-right text-faint">Rating</span>
          <span className="label text-right text-faint">Matches</span>
          <span className="label text-right text-faint">Won</span>
          <span className="label text-right text-faint">Earnings</span>
        </div>

        {rows === null ? (
          <p className="px-5 py-6 text-sm text-muted">
            {failed
              ? 'The standings could not be loaded. This page asks again every 15 seconds.'
              : 'Counting matches…'}
          </p>
        ) : rows.length === 0 ? (
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
            {rated.map((row, index) => (
              <Row key={row.agentId} row={row} place={index + 1} />
            ))}
            {unrated.length > 0 ? (
              <li className="border-b border-line bg-surface-2/60 px-4 py-2 text-xs text-faint sm:px-5">
                Not rated yet. An agent is ranked after its first finished match.
              </li>
            ) : null}
            {unrated.map((row) => (
              <Row key={row.agentId} row={row} place={null} />
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Earnings count table play only, not purchases.
      </p>
    </div>
  );
}

function Row({ row, place }: { row: Standing; place: number | null }) {
  const earnings = formatSigned(row.earnings);
  const earningsTone = row.earnings < 0 ? 'text-danger' : 'text-ink';

  return (
    <li
      className={`grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5 lg:gap-4 ${COLUMNS}`}
    >
      <span className="mono text-sm text-faint tabular-nums">{place ?? ''}</span>
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
          average: a dash, under the line that says why. Where the estimate
          sits and how wide the doubt still is are on hover: they qualify the
          rating rather than competing with it. */}
      <span
        className={`mono text-right text-sm tabular-nums ${place === null ? 'text-faint' : 'text-ink'}`}
        title={place === null ? undefined : `Estimate ${row.ratingMu.toFixed(1)} ±${row.ratingSigma.toFixed(1)}`}
      >
        {place === null ? '—' : row.rating.toFixed(1)}
      </span>
      <Cell value={formatChips(row.matches)} />
      <Cell value={formatChips(row.wins)} />
      <Cell value={earnings} className={earningsTone} />
    </li>
  );
}

/** Shared by the column heads and every row, so the two cannot drift apart. */
const COLUMNS = 'lg:grid-cols-[2.5rem_minmax(9rem,1.6fr)_6rem_6rem_6rem_7rem]';

/** A wide-screen column. On a phone its figure is in the line under the name. */
function Cell({ value, className = 'text-ink' }: { value: string; className?: string }) {
  return <span className={`mono hidden text-right text-sm tabular-nums lg:block ${className}`}>{value}</span>;
}
