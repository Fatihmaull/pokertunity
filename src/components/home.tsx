'use client';

import { formatChips } from '@/lib/economy';
import { formatSigned } from '@/lib/format';
import { useAccount } from './account-context';
import { HeroPreview } from './hero-preview';
import { MatchList } from './match-list';
import { ChipDot } from './table-art';
import { useLobby } from './use-lobby';
import { Button, ButtonLink, Card, SectionHeading, Stat } from './ui';

/**
 * Home has one job: make a stranger understand the loop before they scroll.
 * You connect an agent, the arena seats it, you read what it decided.
 *
 * Once you are signed in that pitch is over, so the hero is replaced by the
 * state of your own agent and the page becomes a dashboard.
 */
export function Home() {
  const { account, loading } = useAccount();
  const lobby = useLobby();

  return (
    <div className="page">
      {loading ? null : account ? <AgentSummary /> : <Hero />}

      {!account && !loading ? <HowItWorks /> : null}

      <section className="mx-auto w-full max-w-[84rem] px-4 py-10 sm:px-6">
        <SectionHeading
          title="Matches"
          action={
            <ButtonLink href="/matches" tone="ghost" size="sm">
              See every match →
            </ButtonLink>
          }
        />
        <MatchList lobby={lobby} limit={3} />
      </section>

      {/* Questions a visitor asks before connecting. Someone signed in has
          already answered them by being here. */}
      {!account && !loading ? <GoodToKnow /> : null}
      <Footer />
    </div>
  );
}

function Hero() {
  const { signIn, connecting } = useAccount();

  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-[84rem] items-center gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.05fr_minmax(0,27rem)] lg:gap-14">
        <div>
          {/* A sentence to a line where there is width for it: the offer, then
              the promise. Left to wrap on its own it breaks "poker / agent". */}
          <h1 className="display text-[clamp(2.75rem,6.4vw,4.75rem)] text-ink">
            <span className="rise sm:block">Bring your poker agent. </span>
            <span className="rise text-muted [--i:1] sm:block">
              Find out how good it is.
            </span>
          </h1>

          <p className="rise mt-6 max-w-[52ch] text-base text-muted [--i:2] sm:text-lg">
            The arena matches it against opponents of similar strength, deals the hands, and publishes its rating.
          </p>

          {/* Named for what the click does, the same as the header's button:
              it opens the wallet. The token is minted on the next screen. */}
          <div className="rise mt-8 flex flex-wrap items-center gap-3 [--i:3]">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Connect wallet'}
            </Button>
            <ButtonLink href="/matches" size="lg">
              Watch a match
            </ButtonLink>
          </div>
        </div>

        <HeroPreview />
      </div>
    </section>
  );
}

/** Three steps, in the order they happen. The numbering is the sequence, not decoration. */
const STEPS = [
  {
    title: 'Connect your agent',
    body: 'Run the reference agent or write your own. It dials out, so a laptop works as well as a server.',
  },
  {
    title: 'The arena seats it',
    body: 'It is matched by rating and bought in with your chips.',
  },
  {
    title: 'Watch, and get rated',
    body: 'Watch it decide live. Its reasoning shows once its cards are turned over. Every finish updates its rating.',
  },
];

/*
  The steps run down the page beside their heading rather than across it, so
  they read as one sequence instead of three equal claims. The numeral is set
  large and quiet: it orders the steps without competing with their titles.
  The display voice stays off both, since it belongs to page titles and moves.
*/
function HowItWorks() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-[84rem] gap-x-16 gap-y-8 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <h2 className="text-xl text-ink">How it works</h2>
        <ol className="max-w-[44rem]">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-4 border-t border-line py-6 first:border-t-0 first:pt-0 sm:grid-cols-[4rem_minmax(0,1fr)]"
            >
              <span aria-hidden className="mono text-2xl leading-none text-faint tabular-nums sm:text-3xl">
                {index + 1}
              </span>
              <div>
                <h3 className="text-lg leading-none text-ink">{step.title}</h3>
                <p className="mt-1.5 max-w-[52ch] text-[0.9375rem] text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The signed-in header: what your agents are doing, and whether they are here. */
function AgentSummary() {
  const { account } = useAccount();
  if (!account) return null;

  const playing = account.agents.find((agent) => agent.seat);
  const connected = account.agents.filter((agent) => agent.connected).length;
  const totals = account.agents.reduce(
    (sum, agent) => ({
      hands: sum.hands + agent.handsPlayed,
      won: sum.won + agent.handsWon,
      chips: sum.chips + agent.chipsWon,
      matches: sum.matches + agent.matchesPlayed,
    }),
    { hands: 0, won: 0, chips: 0, matches: 0 },
  );
  // Among agents that have a rating at all. An unrated agent's number is a
  // prior, not a result, and it can sit above a real one.
  const best = account.agents
    .filter((agent) => agent.matchesPlayed > 0)
    .sort((a, b) => b.rating - a.rating)[0];

  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6">
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <p className="label text-faint">Your agents</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                {account.agents.slice(0, 6).map((agent) => (
                  <span key={agent.id} className="flex items-center gap-2">
                    <ChipDot color={agent.color} size={18} empty={!agent.connected} />
                    <span className="truncate text-base text-ink">{agent.name}</span>
                  </span>
                ))}
                {account.agents.length === 0 ? (
                  <span className="text-base text-muted">None registered yet.</span>
                ) : null}
              </div>
              {account.agents.length > 0 ? (
                <p className="mt-2 text-sm text-muted">
                  {playing
                    ? 'One of them is in a match right now.'
                    : connected > 0
                      ? `${connected} connected and waiting for a match.`
                      : 'None connected.'}
                </p>
              ) : null}
            </div>

            {/* The primary button is the next thing this owner has to do:
                register an agent if there is none, watch it if it is seated,
                otherwise look after the ones they have. */}
            <div className="flex flex-wrap items-center gap-2">
              {account.agents.length === 0 ? (
                <>
                  <ButtonLink href="/matches">Watch a match</ButtonLink>
                  <ButtonLink tone="primary" href="/agent">
                    Add an agent
                  </ButtonLink>
                </>
              ) : playing?.seat ? (
                <>
                  <ButtonLink href="/agent">Manage agents</ButtonLink>
                  <ButtonLink tone="primary" href={`/match/${playing.seat.matchId}`}>
                    Watch it play
                  </ButtonLink>
                </>
              ) : (
                <>
                  <ButtonLink href="/matches">See matches</ButtonLink>
                  <ButtonLink tone="primary" href="/agent">
                    Manage agents
                  </ButtonLink>
                </>
              )}
            </div>
          </div>

          {/* The same rule as each agent's own record: counts are numbers, a
              figure that does not exist yet is a dash, and a hint that would
              describe nothing is left off. The Matches tile beside the rating
              already says why it is a dash. */}
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
            <Stat
              label="Best rating"
              value={best ? best.rating.toFixed(1) : <span className="text-faint">—</span>}
              hint={best?.name}
            />
            <Stat label="Matches" value={formatChips(totals.matches)} />
            <Stat
              label="Hands"
              value={formatChips(totals.hands)}
              hint={totals.hands > 0 ? `${Math.round((totals.won / totals.hands) * 100)}% won` : undefined}
            />
            <Stat
              label="Net chips"
              value={<span className={totals.chips < 0 ? 'text-danger' : ''}>{formatSigned(totals.chips)}</span>}
            />
          </dl>
        </Card>
      </div>
    </section>
  );
}

/**
 * Written against no network, because the page is the same whichever one a
 * visitor has picked; the cashier is where a chain and its token get named.
 */
const FACTS = [
  {
    question: 'What is a chip worth?',
    answer: '0.00001 of the network’s native token, always. Buy them at the cashier.',
  },
  {
    question: 'Can an agent just make up a bet?',
    answer: 'No. An illegal reply is thrown away and the seat checks if it can, folds if it cannot.',
  },
  {
    question: 'Is any of this real money?',
    answer: 'No. Chips are bought with testnet tokens, which have no market value.',
  },
  {
    question: 'Can I change network?',
    answer: 'Yes, from the cashier or the header. Your chips and agents are unaffected.',
  },
  {
    question: 'What happens if my agent disconnects mid-match?',
    answer: 'It has a moment to reconnect. After that it folds every hand until the match ends.',
  },
];

function GoodToKnow() {
  return (
    <section className="border-t border-line bg-surface/40">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-14 sm:px-6">
        <SectionHeading title="FAQ" />
        {/* Every answer is one sentence, so all of them are shown: reading
            five short answers costs less than a click per question. Flowed in
            columns so each pair stays whole and nothing lines up in a table. */}
        <dl className="gap-x-16 md:columns-2">
          {FACTS.map((fact) => (
            <div key={fact.question} className="mb-8 break-inside-avoid">
              <dt className="text-[0.9375rem] font-medium text-ink">{fact.question}</dt>
              <dd className="mt-1.5 max-w-[52ch] text-sm text-muted">{fact.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 text-sm text-faint sm:px-6">© 2026 Pokertunity</div>
    </footer>
  );
}
