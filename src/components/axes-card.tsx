'use client';

import { useEffect, useState } from 'react';
import type { Axes } from '@/lib/axes';
import { formatSigned } from '@/lib/format';
import { Stat } from './ui';

/**
 * The four claims, as numbers.
 *
 * A chip count says whether an agent made money. These say whether it read the
 * table, got believed, learned anything, and punished the weakest opponents
 * harder than everyone else does. Published work on poker-playing models found those orderings
 * routinely disagree, which is the whole reason to show both.
 */
const AXES: Array<{
  key: keyof Axes;
  label: string;
  /** Under the figure, so the tile says what it measures in a word. */
  hint: string;
  /** The whole question, on hover. */
  asks: string;
  format: (value: number) => string;
}> = [
  {
    key: 'reading',
    label: 'Reading',
    hint: 'loose vs tight opponents',
    asks: 'Does it play differently against loose opponents than tight ones?',
    format: (value) => `${formatSigned(value * 100)} pts`,
  },
  {
    key: 'deception',
    label: 'Deception',
    hint: 'weak-hand bets that win',
    asks: 'How often does a bet made with a weak hand take the pot down?',
    format: (value) => `${(value * 100).toFixed(0)}%`,
  },
  {
    key: 'adaptation',
    label: 'Adaptation',
    hint: 'late vs early in a stint',
    asks: 'Does it do better later in a stint than it did at the start of one?',
    format: (value) => `${formatSigned(value, 1)} bb/100`,
  },
  {
    key: 'exploitation',
    label: 'Exploitation',
    hint: 'edge on the weakest',
    asks: 'Does it beat the weakest opponents harder than everyone else does?',
    format: (value) => `${formatSigned(value, 1)} bb/100`,
  },
];

/** How long a measurement is reused before it is asked for again. */
const KEEP_MS = 5 * 60_000;

function recall(agentId: string): Axes | null {
  try {
    const raw = sessionStorage.getItem(`axes:${agentId}`);
    if (!raw) return null;
    const { at, axes } = JSON.parse(raw) as { at: number; axes: Axes };
    return Date.now() - at < KEEP_MS ? axes : null;
  } catch {
    return null;
  }
}

function keep(agentId: string, axes: Axes): void {
  try {
    sessionStorage.setItem(`axes:${agentId}`, JSON.stringify({ at: Date.now(), axes }));
  } catch {
    // Storage refused, as in a private window. The card simply asks next time.
  }
}

export function AxesCard({ agentId }: { agentId: string }) {
  // Read once, as the card is first drawn. It is drawn in the browser, once
  // the account has loaded, so the remembered answer is the first render.
  const [axes, setAxes] = useState<Axes | null>(() => recall(agentId));
  /** Set when the fetch failed, which differs from an empty measurement. */
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // These are measured over thousands of hands and barely move from one
    // minute to the next, while the route is the most expensive read there is
    // and is limited to match. A console with every agent an account may run
    // asks for all of them on each load, so re-asking on every reload ran the
    // page into its own limit by the third. A recent answer is reused.
    if (recall(agentId)) return;

    // Told to wait, it waits as long as it was told and asks again, for as long
    // as the card is on screen, so a refusal reads as a pause. Asking again is
    // free, since the limit refuses before any measuring is done. The cards of
    // one console are told the same wait, so each adds a little jitter of its
    // own and they come back spread out.
    const load = () => {
      fetch(`/api/agents/${agentId}/axes`, { cache: 'no-store' })
        .then(async (response) => {
          if (!live) return;
          if (response.ok) {
            const measured = (await response.json()) as Axes;
            keep(agentId, measured);
            setAxes(measured);
            setUnavailable(false);
            return;
          }
          const wait = Number(response.headers.get('retry-after'));
          if (response.status === 429) {
            const seconds = Number.isFinite(wait) && wait > 0 ? wait : 6;
            retry = setTimeout(load, seconds * 1000 + Math.random() * 4_000);
            return;
          }
          setUnavailable(true);
        })
        .catch(() => {
          if (live) setUnavailable(true);
        });
    };
    load();

    return () => {
      live = false;
      if (retry) clearTimeout(retry);
    };
  }, [agentId]);

  // Null is distinct from zero. It means this agent is still short of the
  // sample the measurement needs, and a dash says exactly that. A fetch in
  // flight is distinct too, so the card claims a figure once the answer has
  // arrived.
  const measured = axes === null ? 0 : AXES.filter((axis) => axes[axis.key] !== null).length;
  const status =
    axes === null
      ? unavailable
        ? 'Unavailable'
        : 'Loading…'
      : measured === 0
        ? 'Needs more hands'
        : `${measured} of ${AXES.length} measured`;

  return (
    <section>
      {/* Label on the left, where it stands on the right: the same line the
          on-chain record below it uses, so the two read as a pair. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="label text-muted">Play profile</h3>
        <span className="mono text-xs text-muted tabular-nums">{status}</span>
      </div>

      {/* Tiles appear once there is a figure to put in one, so the profile reads
      as early, which it is. */}
      {measured > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {AXES.map((axis) => {
            const value = axes?.[axis.key] ?? null;
            return (
              <Stat
                key={axis.key}
                label={axis.label}
                title={axis.asks}
                hint={value === null ? 'needs more hands' : axis.hint}
                value={value === null ? <span className="text-faint">–</span> : axis.format(value)}
              />
            );
          })}
        </dl>
      ) : null}
    </section>
  );
}
