import { notFound } from 'next/navigation';
import { Arena } from '@/components/arena';
import { MatchResult } from '@/components/match-result';
import { matchLabel } from '@/lib/format';
import { getSession } from '@/server/auth';
import { matchNumber, matchSummary } from '@/server/store';

export async function generateMetadata(props: PageProps<'/match/[id]'>) {
  const { id } = await props.params;
  const number = await matchNumber(id).catch(() => null);
  // No suffix: the layout's title template adds "· Pokertunity".
  return number === null ? {} : { title: matchLabel(number) };
}

/**
 * Nothing about a match is cacheable. Whether it is still being dealt is the
 * first thing this page decides, and a cached answer to that is a page that
 * either opens a feed for a match that has ended or refuses one that is live.
 */
export const dynamic = 'force-dynamic';

/**
 * One route, two pages, decided by whether the match is still being dealt.
 *
 * A live match gets the table and its feed. A finished one gets its result,
 * read from the database, because its runtime is gone and its feed answers 503
 * forever. Deciding here rather than in the browser matters: the client cannot
 * tell "this match is over" from "this instance is not the one dealing it", and
 * would retry a stream that is never going to open.
 */
export default async function Page(props: PageProps<'/match/[id]'>) {
  const { id } = await props.params;

  const session = await getSession();
  const summary = await matchSummary(id, session?.userId ?? null).catch(() => null);

  if (!summary) notFound();
  if (summary.status !== 'playing') return <MatchResult summary={summary} />;

  return <Arena matchId={id} />;
}
