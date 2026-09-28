import Link from 'next/link';
import { formatChips } from '@/lib/economy';
import { formatSigned } from '@/lib/format';
import type { MatchSummary } from '@/server/store';
import { Badge, ButtonLink, Card } from './ui';

/**
 * A match that is over.
 *
 * This exists because "over" used to have no screen. The feed for a settled
 * match answers 503 — its runtime was dropped the moment its chips went back —
 * and the live table sat on "Loading match…" retrying it forever. Everything
 * here was already stored; it simply had nowhere to be read.
 *
 * An abandoned match is shown as emphatically as a finished one. It is the case
 * an entrant is most likely to be confused by: their chips left, the hands were
 * dealt, and then the match disappeared without ever saying what happened to
 * the stack.
 */

function endingOf(status: string): { label: string; tone: 'neutral' | 'warn'; blurb: string } {
  if (status === 'elimination') {
    return {
      label: 'Won outright',
      tone: 'neutral',
      blurb: 'One agent took every chip.',
    };
  }
  if (status === 'cap') {
    return {
      label: 'Hand limit',
      tone: 'neutral',
      blurb: 'The hands ran out. Remaining stacks decided the order.',
    };
  }
  return {
    label: 'Abandoned',
    tone: 'warn',
    blurb: 'The server stopped mid-match. Every stack was returned and nobody was rated.',
  };
}

export function MatchResult({ summary }: { summary: MatchSummary }) {
  const ending = endingOf(summary.status);
  const rated = summary.entrants.some((entrant) => entrant.place !== null);

  return (
    <div className="page mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <nav className="text-sm text-faint">
        <Link href="/matches" className="hover:text-ink">
          Matches
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="font-mono">{summary.matchId.slice(0, 8)}</span>
      </nav>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {summary.smallBlind}/{summary.bigBlind} match
        </h1>
        <Badge tone={ending.tone === 'warn' ? 'warning' : 'neutral'}>{ending.label}</Badge>
      </div>

      {/* The same one line the live table carries. These are the terms of
          the match, not its result, so they do not get a card each. */}
      <p className="mt-1 text-sm text-muted">
        {summary.entrants.length} agents · {summary.handsPlayed}/{summary.handCap} hands ·{' '}
        {formatChips(summary.buyIn)} buy-in · {formatChips(summary.entryFee)} entry fee
      </p>

      <p className="mt-3 max-w-2xl text-sm text-muted">{ending.blurb}</p>

      {/*
        The one figure an entrant actually came back for. It is read from the
        ledger entry written in the same transaction that moved the chips, so it
        is what landed rather than what ought to have.
      */}
      {summary.cashOut !== null && (
        <Card className="mt-3 p-4">
          <div className="text-xs text-faint">Returned to your balance</div>
          {/* An amount, not a change, so it carries no sign: "+0" read as a
              gain of nothing rather than as nothing coming back. */}
          <div className="mt-1 font-mono text-2xl text-accent">{formatChips(summary.cashOut)}</div>
          <p className="mt-1 text-sm text-muted">The entry fee is not refunded.</p>
        </Card>
      )}

      <Card className="mt-5 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-faint">
            <tr>
              <th className="px-4 py-3 font-normal">{rated ? '#' : ''}</th>
              <th className="px-4 py-3 font-normal">Agent</th>
              <th className="px-4 py-3 text-right font-normal">Final stack</th>
              <th className="px-4 py-3 text-right font-normal">Chips won</th>
              <th className="px-4 py-3 text-right font-normal">Rating</th>
            </tr>
          </thead>
          <tbody>
            {summary.entrants.map((entrant) => (
              <tr key={entrant.agentId} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-faint">{entrant.place ?? '—'}</td>
                <td className="px-4 py-3 font-medium">
                  {entrant.name}
                  {entrant.agentId === summary.mine ? (
                    <Badge tone="accent" className="ml-2 align-middle">
                      Yours
                    </Badge>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {entrant.finalStack === null ? '—' : formatChips(entrant.finalStack)}
                </td>
                <td className={`px-4 py-3 text-right font-mono ${entrant.net < 0 ? 'text-danger' : ''}`}>
                  {formatSigned(entrant.net)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-faint">
                  {entrant.ratingAfter === null
                    ? 'unrated'
                    : `${entrant.ratingBefore?.toFixed(1)} → ${entrant.ratingAfter.toFixed(1)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-5">
        <ButtonLink href="/matches">Back to matches</ButtonLink>
      </div>
    </div>
  );
}
