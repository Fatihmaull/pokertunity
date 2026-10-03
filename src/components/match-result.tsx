import { formatChips } from '@/lib/economy';
import { formatSigned, matchLabel } from '@/lib/format';
import type { MatchSummary } from '@/server/store';
import { BackLink, Badge, ButtonLink, Card, PageHeader } from './ui';

/**
 * A match that is over.
 *
 * Read from what is stored, because the feed for a settled match answers 503:
 * its runtime is dropped the moment its chips go back.
 *
 * An abandoned match is shown as emphatically as a finished one. It is the case
 * an entrant is most likely to be confused by: their chips left, the hands were
 * dealt, and then the match disappeared without ever saying what happened to
 * the stack.
 */

function endingOf(status: string): string {
  if (status === 'elimination') return 'One agent took every chip.';
  if (status === 'cap') return 'The hands ran out. Remaining stacks decided the order.';
  return 'The server stopped mid-match. Every stack was returned and nobody was rated.';
}

export function MatchResult({ summary }: { summary: MatchSummary }) {
  const rated = summary.entrants.some((entrant) => entrant.place !== null);

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <div className="max-w-4xl">
        {/* These are the terms of the match, not its result, so they do not
            get a card each. */}
        <PageHeader
          back={<BackLink href="/matches">Matches</BackLink>}
          title={matchLabel(summary.number)}
          badges={<Badge>{summary.status === 'abandoned' ? 'Stopped' : 'Ended'}</Badge>}
          sub={
            <>
              <span className="block tabular-nums">
                {summary.entrants.length} agents · {summary.handsPlayed}/{summary.handCap} hands ·{' '}
                {formatChips(summary.buyIn)} buy-in · {formatChips(summary.entryFee)} entry fee
              </span>
              <span className="mt-3 block">{endingOf(summary.status)}</span>
            </>
          }
        />

        {/*
          The one figure an entrant actually came back for. It is read from the
          ledger entry written in the same transaction that moved the chips, so it
          is what landed rather than what ought to have.
        */}
        {summary.cashOut !== null && (
          <Card className="mb-5 p-4">
            <p className="label text-faint">Returned to your balance</p>
            {/* An amount, not a change, so it carries no sign: "+0" read as a
                gain of nothing rather than as nothing coming back. */}
            <p className="mono mt-1 text-2xl text-accent tabular-nums">{formatChips(summary.cashOut)}</p>
          </Card>
        )}

        {/* Five columns do not fit a phone, so there the two figures the
            match changed are one quiet line under the name, the way the
            standings set theirs, and the names keep the width. The place is
            set in ink: on this page it is the result. */}
        <Card className="overflow-hidden">
          <div className="scroll-x">
            <table className="w-full text-sm sm:min-w-[34rem]">
              <thead className="border-b border-line bg-surface-2 text-left">
                <tr>
                  <th className="label px-4 py-2.5 text-faint">{rated ? '#' : ''}</th>
                  <th className="label px-4 py-2.5 text-faint">Agent</th>
                  <th className="label px-4 py-2.5 text-right text-faint">Final stack</th>
                  <th className="label hidden px-4 py-2.5 text-right text-faint sm:table-cell">Chips won</th>
                  <th className="label hidden px-4 py-2.5 text-right text-faint sm:table-cell">Rating</th>
                </tr>
              </thead>
              <tbody>
                {summary.entrants.map((entrant) => {
                  const won = formatSigned(entrant.net);
                  const wonTone = entrant.net < 0 ? 'text-danger' : 'text-ink';
                  const rating =
                    entrant.ratingAfter === null
                      ? null
                      : `${entrant.ratingBefore?.toFixed(1)} → ${entrant.ratingAfter.toFixed(1)}`;

                  return (
                    <tr key={entrant.agentId} className="border-b border-line last:border-0">
                      <td
                        className={`mono px-4 py-3 align-top tabular-nums sm:align-middle ${
                          entrant.place === null ? 'text-faint' : 'text-ink'
                        }`}
                      >
                        {entrant.place ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-ink">{entrant.name}</span>
                        {entrant.agentId === summary.mine ? (
                          <Badge tone="accent" className="ml-2 align-middle">
                            Yours
                          </Badge>
                        ) : null}
                        <span className="mono mt-0.5 block text-xs text-faint tabular-nums sm:hidden">
                          <span className={wonTone}>{won}</span>
                          {rating ? ` · rating ${rating}` : null}
                        </span>
                      </td>
                      <td className="mono px-4 py-3 text-right align-top text-ink tabular-nums sm:align-middle">
                        {entrant.finalStack === null ? '—' : formatChips(entrant.finalStack)}
                      </td>
                      <td className={`mono hidden px-4 py-3 text-right tabular-nums sm:table-cell ${wonTone}`}>{won}</td>
                      <td className="mono hidden px-4 py-3 text-right text-muted tabular-nums sm:table-cell">
                        {rating ?? <span className="text-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="mt-5">
          <ButtonLink href="/matches">Back to matches</ButtonLink>
        </div>
      </div>
    </div>
  );
}
