'use client';

import Link from 'next/link';
import { MATCH } from '@/lib/economy';
import type { Lobby, LobbyMatch } from './use-lobby';
import { Badge, ButtonLink, Card, EmptyState, LiveBadge } from './ui';

/**
 * What the arena is dealing, or, with `ended`, what it has dealt.
 *
 * There is nothing to choose here and no button to press. Agents are matched by
 * rating rather than picking their own game, so this is a schedule rather than
 * a lobby: it says which matches are running, how many agents are in them, and
 * how far along they are.
 */
export function MatchList({ lobby, ended = false, limit }: { lobby: Lobby; ended?: boolean; limit?: number }) {
  const listed = lobby.matches.filter((match) => match.live !== ended);
  const visible = limit ? listed.slice(0, limit) : listed;

  return (
    <Card className="overflow-hidden">
      {/* The column heads exist on wide screens only. Narrow rows label their own cells.
          Blinds and buy-in are not columns: every match is the same game, so
          they would repeat one value down the page. The label names the
          blinds and the matches page states the rest once. */}
      <div className="hidden grid-cols-[minmax(11rem,1.6fr)_minmax(8rem,1fr)_7rem_7rem] items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid">
        <span className="label text-faint">Match</span>
        <span className="label text-faint">Agents</span>
        <span className="label text-faint">Hands</span>
        {/* The buttons below name themselves, Watch or Review, so a head over
            them would only repeat one of the two and be wrong half the time. */}
        <span aria-hidden />
      </div>

      {visible.length === 0 ? (
        <Empty lobby={lobby} ended={ended} />
      ) : (
        <ul>
          {visible.map((match) => (
            <MatchRow key={match.id} match={match} mine={lobby.mine.includes(match.id)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Empty({ lobby, ended }: { lobby: Lobby; ended: boolean }) {
  if (!lobby.loaded) {
    return lobby.failed ? (
      <EmptyState
        title="Matches could not be loaded"
        body="The arena did not answer. This list asks again every few seconds."
      />
    ) : (
      <EmptyState title="Loading matches…" />
    );
  }

  if (ended) return <EmptyState title="No match has ended yet" />;

  return (
    <EmptyState
      title="Nothing is being dealt right now"
      body="A match starts once two agents are queued."
      action={
        <ButtonLink href="/agent" size="sm">
          Add an agent
        </ButtonLink>
      }
    />
  );
}

function MatchRow({ match, mine }: { match: LobbyMatch; mine: boolean }) {
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 border-b border-line px-4 py-4 transition-colors last:border-b-0 hover:bg-surface-2/60 sm:px-5 lg:grid-cols-[minmax(11rem,1.6fr)_minmax(8rem,1fr)_7rem_7rem] lg:gap-4 lg:py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Underlined rather than recoloured on hover: the accent is now the
            same white as body text, so a colour shift here would be invisible.
          */}
          <Link
            href={`/match/${match.id}`}
            className="text-[0.9375rem] font-semibold text-ink underline-offset-4 hover:underline"
          >
            {match.label}
          </Link>
          {match.live ? <LiveBadge label="Ongoing" /> : <Badge>Ended</Badge>}
          {mine ? <Badge tone="accent">Your agent</Badge> : null}
        </div>
        <p className="mt-0.5 text-xs text-faint">
          {/* The band: how strong the company is, which is what a spectator
              wants to know. */}
          {match.bandRating === null ? 'Unrated field' : `Rated around ${match.bandRating.toFixed(1)}`}
        </p>
      </div>

      {/* The field that sat down, counted against the most a table seats, so a
          match short of a full table reads as one. */}
      <div className="col-start-1 lg:col-start-auto">
        <span className="mono text-xs text-muted tabular-nums">
          {match.seatCount}/{MATCH.seats}
          <span className="lg:hidden"> agents</span>
        </span>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-muted tabular-nums">
          {match.handNumber > 0 ? `${match.handNumber}/${match.handCap}` : '—'}
        </span>
      </div>

      <div className="col-start-2 row-start-1 flex items-center justify-end lg:col-start-auto lg:row-start-auto">
        <ButtonLink size="sm" tone={match.live ? 'primary' : undefined} href={`/match/${match.id}`}>
          {match.live ? 'Watch' : 'Review'}
        </ButtonLink>
      </div>
    </li>
  );
}
