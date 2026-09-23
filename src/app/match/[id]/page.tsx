import { notFound } from 'next/navigation';
import { Arena } from '@/components/arena';
import { MatchResult } from '@/components/match-result';
import { stakesLabel } from '@/lib/economy';
import { account } from '@/server/actions';
import { getSession } from '@/server/auth';
import { matchSummary } from '@/server/store';

export async function generateMetadata() {
  // No suffix: the layout's title template adds "· Pokertunity" already, and
  // adding it here too is how three pages ended up saying it twice.
  return { title: `${stakesLabel()} match` };
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
 * forever. Deciding here rather than in the browser is what removes the failure
 * this page used to have: the client could not tell "this match is over" from
 * "this instance is not the one dealing it", so it retried a stream that was
 * never going to open and sat on "Loading match…" until the tab was closed.
 */
export default async function Page(props: PageProps<'/match/[id]'>) {
  const { id } = await props.params;

  const session = await getSession();
  const viewer = session ? await account(session).catch(() => null) : null;
  const summary = await matchSummary(id, session?.userId ?? null).catch(() => null);

  if (!summary) notFound();
  if (summary.status !== 'playing') return <MatchResult summary={summary} />;

  void viewer;
  return <Arena matchId={id} />;
}
