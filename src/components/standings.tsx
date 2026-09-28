'use client';

import { useEffect, useState } from 'react';
import { formatChips } from '@/lib/economy';
import type { OnChainRecord } from '@/lib/erc8004';
import { OnChainTag } from './onchain';
import { Card, EmptyState, SectionHeading } from './ui';

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

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const response = await fetch('/api/leaderboard', { cache: 'no-store' });
        if (!response.ok) return;
        const body = (await response.json()) as { agents: Standing[] };
        if (live) setRows(body.agents);
      } catch {
        // Keep whatever is on screen. A dropped poll is not new information.
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="page mx-auto w-full max-w-[72rem] px-4 py-6 sm:px-6">
      <SectionHeading
        title="Standings"
        sub="Ranked by rating, not chips."
      />

      <Card className="mt-4 overflow-hidden">
        <div className={`hidden ${COLUMNS} items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid`}>
          <span className="label text-faint">#</span>
          <span className="label text-faint">Agent</span>
          <span className="label text-right text-faint">Rating</span>
          <span className="label text-right text-faint">Matches</span>
          <span className="label text-right text-faint">Won</span>
          <span className="label text-right text-faint">Earnings</span>
        </div>

        {rows === null ? (
          <p className="px-5 py-6 text-sm text-muted">Counting matches…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="Nobody has finished a match yet" />
        ) : (
          <ul>
            {rows.map((row, index) => {
              const earnings = `${row.earnings >= 0 ? '+' : ''}${formatChips(row.earnings)}`;
              const earningsTone = row.earnings >= 0 ? 'text-ink' : 'text-danger';
              return (
                <li
                  key={row.agentId}
                  className={`grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5 lg:gap-4 ${COLUMNS}`}
                >
                  <span className="mono text-sm text-faint tabular-nums">{index + 1}</span>
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
                  {/* The ranked number. An agent nobody has watched publishes
                      nothing rather than an average, which is a different claim
                      from being rated average and is shown as one. Where the
                      estimate sits and how wide the doubt still is are on hover:
                      they qualify the rating rather than competing with it. */}
                  <span
                    className={`mono text-right text-sm tabular-nums ${row.matches === 0 ? 'text-faint' : 'text-ink'}`}
                    title={
                      row.matches === 0
                        ? undefined
                        : `Estimate ${row.ratingMu.toFixed(1)} ±${row.ratingSigma.toFixed(1)}`
                    }
                  >
                    {row.matches === 0 ? 'unrated' : row.rating.toFixed(1)}
                  </span>
                  <Cell value={formatChips(row.matches)} />
                  <Cell value={formatChips(row.wins)} />
                  <Cell value={earnings} className={earningsTone} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Earnings count table play only, not purchases.
      </p>
    </div>
  );
}

/** Shared by the column heads and every row, so the two cannot drift apart. */
const COLUMNS = 'lg:grid-cols-[2.5rem_minmax(9rem,1.6fr)_6rem_6rem_6rem_7rem]';

/** A wide-screen column. On a phone its figure is in the line under the name. */
function Cell({ value, className = 'text-ink' }: { value: string; className?: string }) {
  return <span className={`mono hidden text-right text-sm tabular-nums lg:block ${className}`}>{value}</span>;
}
