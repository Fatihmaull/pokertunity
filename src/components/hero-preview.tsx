'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThinkingPanel, drawsOf, type BrainState } from './thinking-panel';
import { useMatchStream } from './use-match-stream';
import { Badge, Card, LiveBadge } from './ui';

interface ReplayDecision {
  seatIndex: number;
  street: string;
  /** Null for a hand that was mucked. The table kept it private, and so does this. */
  equity: number | null;
  handRead: { made: string; flushDraw: boolean; openEnded: boolean; gutshot: boolean; overcards: boolean } | null;
  reasoning: string | null;
  mucked: boolean;
  action: string;
  amount: number;
  elapsedMs: number;
  outcome: 'decided' | 'timeout' | 'error';
}

type Feed =
  | { mode: 'loading' }
  | { mode: 'live'; matchId: string }
  | {
      mode: 'replay';
      matchId: string;
      handNumber: number;
      lineup: Array<{ seatIndex: number; name: string }>;
      decisions: ReplayDecision[];
    }
  | { mode: 'empty' };

/**
 * A worked example of the thing the page is selling, shown before the reader
 * has to click anything. If a table is dealing it is that table; if one has
 * dealt before it is the last real hand; before the first hand ever dealt it
 * shows a written sample, and says so on the card.
 */
export function HeroPreview() {
  const [feed, setFeed] = useState<Feed>({ mode: 'loading' });
  const [step, setStep] = useState(0);
  /** Held while someone is reading it, so a paragraph stays put mid-sentence. */
  const [held, setHeld] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/hands/latest', { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<Feed>) : ({ mode: 'empty' } satisfies Feed)))
      .then((body) => {
        if (!cancelled) setFeed(body);
      })
      .catch(() => {
        if (!cancelled) setFeed({ mode: 'empty' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = useMatchStream(feed.mode === 'live' ? feed.matchId : null);

  // The decisions of hands that were actually shown. A mucked hand comes back
  // with its reasoning sealed, and the hero is meant to be a full worked
  // example.
  const shown = feed.mode === 'replay' ? feed.decisions.filter((decision) => !decision.mucked) : [];
  const count = shown.length;
  useEffect(() => {
    if (count === 0 || held) return;
    const timer = setInterval(() => setStep((current) => (current + 1) % count), 5200);
    return () => clearInterval(timer);
  }, [count, held]);

  const brain = build(feed, shown, live, step);
  const matchId = feed.mode === 'live' || feed.mode === 'replay' ? feed.matchId : null;

  // A fixed height. The decisions it cycles through run from a line to a
  // paragraph, and a fixed card keeps the headline beside it and everything
  // below it still on every turn. Taller where
  // it is stacked, because the narrower card wraps the same paragraph longer.
  return (
    <Card className="flex h-[32rem] flex-col overflow-hidden lg:h-[28rem]">
      <div
        className="flex min-h-0 flex-1 flex-col"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
          <span className="text-[0.8125rem] font-medium text-ink">What you see while it plays</span>
          <span className="ml-auto">
            {feed.mode === 'live' ? (
              <LiveBadge />
            ) : feed.mode === 'replay' ? (
              <Badge>Last hand</Badge>
            ) : feed.mode === 'empty' ? (
              <Badge>Example</Badge>
            ) : null}
          </span>
        </div>

        <div className="min-h-0 flex-1">
          <ThinkingPanel
            brain={brain}
            live={feed.mode === 'live'}
            deadline={feed.mode === 'live' ? (live.table?.deadline ?? null) : null}
            footnote={footnote(feed, shown, step)}
          />
        </div>

        {matchId ? (
          <Link
            href={`/match/${matchId}`}
            className="shrink-0 border-t border-line px-4 py-2.5 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-surface-2"
          >
            {/* The same two verbs the match list uses for the same two states. */}
            {feed.mode === 'live' ? 'Watch this match →' : 'Review this match →'}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Shown before the first hand is ever dealt, and labelled Example on the card
 * so it reads as a sample.
 */
const SAMPLE: BrainState = {
  seatName: 'Maverick',
  color: 'red',
  street: 'turn',
  reasoning:
    'He has bet every street and I have called every street. The flush card came and he cut his bet to a third of the pot. That is the size you pick when you want a cheap look at the river, and a small one for a made flush. I have nine cards to the nut flush and he is laying me better than three to one to go and get them.',
  streaming: false,
  equity: 0.384,
  potOdds: 0.31,
  made: 'Ace high',
  draws: ['flush draw'],
  action: 'raise',
  amount: 1200,
  failure: null,
  elapsedMs: 4300,
};

function build(
  feed: Feed,
  shown: ReplayDecision[],
  live: ReturnType<typeof useMatchStream>,
  step: number,
): BrainState | null {
  if (feed.mode === 'live') {
    const brain = live.table?.brain;
    if (!brain) return null;
    return {
      seatName: brain.seatName,
      color: brain.color,
      street: brain.street,
      reasoning: brain.reasoning,
      streaming: live.isStreaming,
      sealed: brain.sealed,
      equity: brain.equity,
      potOdds: brain.potOdds,
      made: brain.handRead?.made ?? null,
      draws: drawsOf(brain.handRead),
      action: brain.action,
      amount: brain.amount ?? 0,
      failure: brain.failure,
      elapsedMs: brain.elapsedMs,
    };
  }

  if (feed.mode === 'replay' && shown.length > 0) {
    const decision = shown[step % shown.length];
    return {
      seatName: feed.lineup.find((entry) => entry.seatIndex === decision.seatIndex)?.name ?? null,
      color: null,
      street: decision.street,
      reasoning: decision.reasoning ?? '',
      streaming: false,
      equity: decision.equity,
      potOdds: null,
      made: decision.handRead?.made ?? null,
      draws: drawsOf(decision.handRead),
      action: decision.action,
      amount: decision.amount,
      failure: decision.outcome === 'timeout' ? 'ran out of time' : null,
      elapsedMs: decision.elapsedMs,
    };
  }

  // The last hand was mucked whole, so the sample is the honest thing to show.
  if (feed.mode === 'empty' || feed.mode === 'replay') return SAMPLE;
  return null;
}

function footnote(feed: Feed, shown: ReplayDecision[], step: number): string | null {
  if (feed.mode === 'loading') return 'Loading…';
  if (feed.mode === 'empty') return 'The first hand is still to come.';
  if (feed.mode === 'replay') {
    // Says which hand, and counts the mucked seats too.
    const mucked = feed.decisions.length - shown.length;
    if (shown.length === 0) return 'Last hand was mucked.';

    const tail = mucked > 0 ? ` · ${mucked} mucked, kept private` : '';
    return `Hand ${feed.handNumber} · decision ${(step % shown.length) + 1} of ${shown.length}${tail}`;
  }
  return null;
}
