'use client';

import { useEffect, useState } from 'react';
import { Card } from './ui';

interface Axes {
  reading: number | null;
  deception: number | null;
  adaptation: number | null;
  exploitation: number | null;
}

/**
 * The four claims, as numbers.
 *
 * A chip count says whether an agent made money. These say whether it read the
 * table, got believed, learned anything, and punished the weakest opponents
 * harder than everyone else does. Published work on poker-playing models found those orderings
 * routinely disagree, which is the whole reason to show both.
 */
const AXES: Array<{ key: keyof Axes; label: string; asks: string; format: (value: number) => string }> = [
  {
    key: 'reading',
    label: 'Reading',
    asks: 'Does it play differently against loose opponents than tight ones?',
    format: (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)} pts`,
  },
  {
    key: 'deception',
    label: 'Deception',
    asks: 'How often does a bet made with a weak hand take the pot down?',
    format: (value) => `${(value * 100).toFixed(0)}%`,
  },
  {
    key: 'adaptation',
    label: 'Adaptation',
    asks: 'Does it do better later in a stint than it did at the start of one?',
    format: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} bb/100`,
  },
  {
    key: 'exploitation',
    label: 'Exploitation',
    asks: 'Does it beat the weakest opponents harder than everyone else does?',
    format: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} bb/100`,
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

export function AxesCard({ agentId, name }: { agentId: string; name?: string }) {
  // Read once, as the card is first drawn. It is only ever drawn in the
  // browser, once the account has loaded, so there is no server render for a
  // remembered answer to disagree with.
  const [axes, setAxes] = useState<Axes | null>(() => recall(agentId));
  /** Set when the measurement could not be fetched, which is not the same as there being none. */
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // These are measured over thousands of hands and barely move from one
    // minute to the next, while the route is the most expensive read there is
    // and is limited to match. A console with every agent an account may run
    // asks for all of them on each load, so re-asking on every reload ran the
    // page into its own limit by the third. A recent answer is reused instead.
    if (recall(agentId)) return;

    // Told to wait, it waits as long as it was told and asks again, for as long
    // as the card is on screen, rather than reporting a refusal as though the
    // agent had not played. Giving up after a fixed number of tries lost the
    // race whenever more cards were waiting than the limit refills in that
    // time; asking again costs nothing, since the limit refuses before any
    // measuring is done. The cards of one console are told the same wait, so
    // each adds a little of its own or they all return on the same instant and
    // are refused together again.
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

  return (
    <Card className="p-5">
      <h2 className="truncate text-base text-ink">{name ? `${name} profile` : 'Profile'}</h2>
      <p className="mt-1 text-xs text-faint">
        What the record says beyond the money, measured from hands against other agents. Exploitation is compared
        with how the whole field does against the weakest half of it.
      </p>

      <dl className="mt-4 space-y-4">
        {AXES.map((axis) => {
          const value = axes?.[axis.key] ?? null;
          return (
            <div key={axis.key}>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[0.8125rem] font-medium text-ink">{axis.label}</dt>
                {/* Null is not zero. It means this agent has not played enough
                    for the measurement to say anything, and saying so beats
                    printing a figure that would read as a finding. Nor is a
                    measurement not yet fetched a measurement of nothing, so
                    "not enough hands" waits until the answer has arrived. */}
                <dd className={`mono text-sm tabular-nums ${value === null ? 'text-faint' : 'text-ink'}`}>
                  {axes === null
                    ? unavailable
                      ? 'unavailable'
                      : '…'
                    : value === null
                      ? 'not enough hands'
                      : axis.format(value)}
                </dd>
              </div>
              <p className="mt-0.5 text-xs text-faint">{axis.asks}</p>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}
