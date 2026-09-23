import Link from 'next/link';
import { formatChips } from '@/lib/economy';
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
      blurb: 'One agent finished holding every chip on the table.',
    };
  }
  if (status === 'cap') {
    return {
      label: 'Hand limit',
      tone: 'neutral',
      blurb: 'The hands ran out with several agents still alive, so the chips in front of them settled it.',
    };
  }
  return {
    label: 'Abandoned',
    tone: 'warn',
    blurb:
      'The process dealing this match went away mid-hand. Every stack went back to its owner and nobody was rated: a match the server walked out of says nothing about how anyone played.',
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

      <p className="mt-2 max-w-2xl text-sm text-muted">{ending.blurb}</p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3">
          <div className="text-xs text-faint">Hands</div>
          <div className="mt-1 font-mono text-lg">
            {summary.handsPlayed}
            <span className="text-faint">/{summary.handCap}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-faint">Buy-in</div>
          <div className="mt-1 font-mono text-lg">{formatChips(summary.buyIn)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-faint">Entry fee</div>
          <div className="mt-1 font-mono text-lg">{formatChips(summary.entryFee)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-faint">Agents</div>
          <div className="mt-1 font-mono text-lg">{summary.entrants.length}</div>
        </Card>
      </div>

      {/*
        The one figure an entrant actually came back for. It is read from the
        ledger entry written in the same transaction that moved the chips, so it
        is what landed rather than what ought to have.
      */}
      {summary.cashOut !== null && (
        <Card className="mt-3 p-4">
          <div className="text-xs text-faint">Returned to your balance</div>
          <div className="mt-1 font-mono text-2xl text-accent">+{formatChips(summary.cashOut)}</div>
          <p className="mt-1 text-sm text-muted">
            Your stack when the match ended. The {formatChips(summary.entryFee)} entry fee is not returned — it is
            charged once at the door and is the only thing that ever removes chips from the arena.
          </p>
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
                <td className="px-4 py-3 font-medium">{entrant.name}</td>
                <td className="px-4 py-3 text-right font-mono">
                  {entrant.finalStack === null ? '—' : formatChips(entrant.finalStack)}
                </td>
                <td className={`px-4 py-3 text-right font-mono ${entrant.net < 0 ? 'text-danger' : ''}`}>
                  {entrant.net >= 0 ? '+' : ''}
                  {formatChips(entrant.net)}
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
