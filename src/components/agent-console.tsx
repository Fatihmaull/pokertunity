'use client';

import { useEffect, useState } from 'react';
import { SEAT_COST, formatChips } from '@/lib/economy';
import { useAccount, type AccountAgent } from './account-context';
import { ChipDot } from './table-art';
import { AxesCard } from './axes-card';
import { OnChainPanel } from './onchain';
import { Cashier } from './cashier';
import { Badge, Button, ButtonLink, Card, Disclosure, Stat } from './ui';

/**
 * An operations page, not an editor.
 *
 * There is nothing here that decides how an agent plays, because that lives in
 * a program its owner runs somewhere else. What an owner needs from us instead
 * is the answer to one question they cannot answer alone: what did the arena
 * see. So this shows connection state, when it was last seen, and why the last
 * socket closed, alongside the token it connects with.
 */
export function AgentConsole() {
  const { account, loading, signIn, connecting, refresh } = useAccount();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Shown once, right after minting. It is not stored and cannot be shown again. */
  const [freshToken, setFreshToken] = useState<{ agentId: string; token: string } | null>(null);
  const [cashierOpen, setCashierOpen] = useState(false);
  const signedIn = account !== null;

  // This page is the answer to "what did the arena see", and an answer read
  // once on load is wrong the moment an agent connects, queues or is seated.
  // Asked again while the tab is being looked at, and the moment it is looked
  // at again, rather than on a timer nobody is watching.
  useEffect(() => {
    if (!signedIn) return;
    const look = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    };
    const timer = setInterval(look, STATUS_POLL_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [signedIn, refresh]);

  if (loading) {
    return (
      <Shell>
        <p className="py-20 text-center text-sm text-muted">Loading your agents…</p>
      </Shell>
    );
  }

  if (!account) {
    return (
      <Shell>
        <Card className="mx-auto mt-10 max-w-[46rem] p-8 text-center sm:p-12">
          <h1 className="mx-auto max-w-[26ch] text-2xl text-ink sm:text-3xl">
            Bring an agent. We run the tournament.
          </h1>
          <p className="mx-auto mt-4 max-w-[56ch] text-base text-muted">
            Connect a wallet to get your agent&rsquo;s token. One signature, no transaction, no cost.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Connect wallet'}
            </Button>
            <ButtonLink href="/matches" size="lg">
              Watch a match first
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(body.error ?? 'That did not work.'));
      await refresh();
      return body;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addAgent() {
    const body = await call('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: unusedName(account!.agents) }),
    });
    if (body) setFreshToken({ agentId: String(body.agentId), token: String(body.token) });
  }

  const affordable = account.chips >= SEAT_COST;

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl text-ink sm:text-3xl">Your agents</h1>
          <p className="mt-1.5 max-w-[62ch] text-sm text-muted">
            Each agent connects to the arena over a socket using its own token. It plays when it is connected and
            has asked for a game.
          </p>
        </div>
        <Button tone="primary" onClick={() => void addAgent()} disabled={busy}>
          Add an agent
        </Button>
      </header>

      {failure ? <p className="mb-4 text-sm text-danger">{failure}</p> : null}

      {/* The balance and the Buy button are in the header on every page. Here
          it is worth a line only when it is what stands between an agent and
          a seat. */}
      {affordable ? null : (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-5 py-4">
          <p className="text-sm text-ink">
            Not enough chips for a match. A seat costs {formatChips(SEAT_COST)}.
          </p>
          <Button tone="primary" size="sm" onClick={() => setCashierOpen(true)}>
            Buy chips
          </Button>
        </div>
      )}

      <div className="space-y-5">
        {account.agents.length === 0 ? (
          <Card className="p-8 text-center">
            <h2 className="text-lg text-ink">No agents yet</h2>
            <p className="mx-auto mt-2 max-w-[52ch] text-sm text-muted">Add one to get its token.</p>
          </Card>
        ) : (
          account.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              busy={busy}
              affordable={affordable}
              token={freshToken?.agentId === agent.id ? freshToken.token : null}
              onRotate={async () => {
                const body = await call(`/api/agents/${agent.id}/rotate`, { method: 'POST' });
                if (body) setFreshToken({ agentId: agent.id, token: String(body.token) });
              }}
              onRename={(name) => void call(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })}
              onQueue={(enabled) =>
                void call(`/api/agents/${agent.id}/queue`, { method: 'POST', body: JSON.stringify({ enabled }) })
              }
            />
          ))
        )}

        {/* Open until an agent has made it in once. After that the owner
            knows how, and it is only in the way of the agents themselves. */}
        <ConnectGuide open={account.agents.every((agent) => !agent.connected && !agent.lastSeenAt)} />
      </div>
      {cashierOpen ? <Cashier onClose={() => setCashierOpen(false)} /> : null}
    </Shell>
  );
}

function AgentCard({
  agent,
  busy,
  affordable,
  token,
  onRotate,
  onRename,
  onQueue,
}: {
  agent: AccountAgent;
  busy: boolean;
  affordable: boolean;
  token: string | null;
  onRotate: () => void;
  onRename: (name: string) => void;
  onQueue: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? agent.name;
  const winRate = agent.handsPlayed > 0 ? `${Math.round((agent.handsWon / agent.handsPlayed) * 100)}%` : '—';

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChipDot color={agent.color} size={22} />
          <input
            value={name}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== null && draft.trim() && draft !== agent.name) onRename(draft.trim());
              setDraft(null);
            }}
            // Enter is what everyone presses to finish typing a name, and
            // leaving the field is what saves it.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            maxLength={24}
            aria-label="Agent name"
            className="h-9 w-full max-w-[18rem] rounded-control border border-transparent bg-transparent px-2 text-lg text-ink outline-none hover:border-line focus:border-accent focus:bg-surface-2"
          />
        </div>
        <Status agent={agent} affordable={affordable} />
      </div>

      <QueueSwitch agent={agent} disabled={busy} onChange={onQueue} />

      {/*
        Shown once, immediately after minting. Only the hash is stored, so this
        is the only moment the token exists anywhere we can show it. An owner
        who misses it rotates, which is the honest answer rather than an
        inconvenience worked around.
      */}
      {token ? <FreshToken token={token} connected={agent.connected} /> : null}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
        <Stat
          label="Rating"
          value={agent.matchesPlayed > 0 ? agent.rating.toFixed(1) : '—'}
          hint={`${agent.matchesPlayed} match${agent.matchesPlayed === 1 ? '' : 'es'}`}
        />
        <Stat label="Hands" value={agent.handsPlayed.toLocaleString('en-US')} hint={`${winRate} won`} />
        <Stat label="Net chips" value={`${agent.chipsWon >= 0 ? '+' : ''}${formatChips(agent.chipsWon)}`} />
        <Stat label="Biggest pot" value={formatChips(agent.biggestPot)} />
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {agent.seat ? (
          <ButtonLink href={`/match/${agent.seat.matchId}`} tone="primary" size="sm">
            Watch it play
          </ButtonLink>
        ) : null}
        <Button size="sm" onClick={onRotate} disabled={busy}>
          Rotate token
        </Button>
        {agent.lastCloseReason ? (
          <span className="text-xs text-faint">Last disconnect: {agent.lastCloseReason}</span>
        ) : agent.lastSeenAt ? (
          <span className="text-xs text-faint">
            Last seen {new Date(agent.lastSeenAt).toLocaleString('en-US')}
          </span>
        ) : (
          <span className="text-xs text-faint">Never connected</span>
        )}
      </div>

      {/* Measured over thousands of hands, so it says little early on and
          changes slowly after that: worth a look now and then, not a place on
          screen every time the page is opened. */}
      <Disclosure summary="Profile and on-chain record" className="mt-4 border-t border-line pt-4">
        <div className="space-y-5 pb-1">
          <AxesCard agentId={agent.id} />
          <OnChainPanel agentId={agent.id} records={agent.onchain} hands={agent.handsPlayed} />
        </div>
      </Disclosure>
    </Card>
  );
}

/** The one thing an owner debugging a silent agent actually needs. */
/**
 * The token, at the only moment it exists anywhere we can show it.
 *
 * Only the hash is stored, so this is one shot. That made the display the
 * least forgiving interaction in the product: 46 characters in a box that
 * scrolls under your finger, with no second chance. A laptop survives it on a
 * triple-click, which is probably why it lasted; a phone does not.
 *
 * The input is the fallback rather than the decoration. A clipboard write can
 * be refused — an insecure origin, a browser that wants a user gesture it did
 * not see — and when it is, a real field the player can select from is the
 * difference between an inconvenience and a lost token.
 */
function FreshToken({ token, connected }: { token: string; connected: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Left for the player to select by hand, which is why it is an input.
      setCopied(false);
    }
  }

  return (
    <div className="mt-4 rounded-control border border-accent/40 bg-accent/5 p-3">
      <p className="text-xs font-medium text-ink">Copy this now. It is not shown again.</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          readOnly
          value={token}
          aria-label="Agent token"
          onFocus={(event) => event.currentTarget.select()}
          className="mono min-w-0 flex-1 rounded-control border border-line bg-surface-2 px-2 py-1.5 text-xs text-accent"
        />
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      {/*
        Rotation refuses the old token on the next connection and leaves the one
        already open alone. Whoever rotated because the token leaked needs to
        hear that here, or they walk away believing the leak is closed. The
        remedy is connecting on the new token, because a second connection for
        an agent replaces the first and the seat belongs to the agent.
      */}
      {connected ? (
        <p className="mt-2 text-xs text-muted">
          The open connection still uses the old token. Restart your agent with this one to close it.
        </p>
      ) : null}
    </div>
  );
}

function Status({ agent, affordable }: { agent: AccountAgent; affordable: boolean }) {
  if (agent.seat) return <Badge tone="accent">In a match</Badge>;
  if (!agent.connected) return <Badge>Not connected</Badge>;
  if (!agent.queueEnabled) return <Badge>Connected, matches off</Badge>;
  if (!agent.ready) return <Badge>Connected, not queued</Badge>;
  if (!affordable) return <Badge tone="danger">Queued, not enough chips</Badge>;
  return <Badge tone="accent">Queued</Badge>;
}

/**
 * The owner's say in whether this agent is seated.
 *
 * The agent asks by saying `ready`; this is the owner agreeing to it. Off for a
 * new agent, so the first run of freshly written code connects and can be
 * watched answering without being charged a seat. Turning it off mid-match
 * stops the next match, not this one, because nobody leaves a match.
 */
function QueueSwitch({
  agent,
  disabled,
  onChange,
}: {
  agent: AccountAgent;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const on = agent.queueEnabled;
  const label = `Play matches: ${agent.name}`;

  return (
    <div className="mt-4 flex items-center gap-3">
      {/* The thumb is placed absolutely from the track's centre line rather
          than left in the flow, so it sits dead centre whatever the border and
          line box around it add up to. */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
          on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3'
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-1/2 left-0.5 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-transform ${
            on ? 'translate-x-4 bg-accent-ink' : 'translate-x-0 bg-muted'
          }`}
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm text-ink">Play matches {on ? 'on' : 'off'}</p>
        <p className="text-xs text-faint">
          {on
            ? agent.seat
              ? 'Turning this off takes effect after this match.'
              : `${formatChips(SEAT_COST)} per match.`
            : 'Connects without being seated or charged.'}
        </p>
      </div>
    </div>
  );
}

/** How often the page asks what the arena sees of these agents. */
const STATUS_POLL_MS = 5_000;

/**
 * A default name no other agent on this account already has.
 *
 * Counting agents alone collides as soon as one has been renamed: an owner
 * holding "Agent 1" and a renamed "Agent 3" would be offered "Agent 3" again,
 * refused, and offered it again on every click.
 */
function unusedName(agents: readonly AccountAgent[]): string {
  const taken = new Set(agents.map((agent) => agent.name.toLowerCase()));
  let n = agents.length + 1;
  while (taken.has(`agent ${n}`)) n += 1;
  return `Agent ${n}`;
}

function ConnectGuide({ open }: { open: boolean }) {
  return (
    <Card className="p-5">
      <Disclosure summary={<span className="text-base text-ink">How to connect</span>} defaultOpen={open}>
        <pre className="scroll-x mono rounded-control border border-line bg-surface-2 p-3 text-xs text-muted">
{`ARENA_URL=wss://<this-host>/agent \\
AGENT_TOKEN=ah_... \\
AGENT_BRAIN=heuristic \\
pnpm --filter @pokertunity/agent start`}
        </pre>
        <p className="mt-3 max-w-[62ch] text-xs text-faint">
          The heuristic brain needs no model key. Set AGENT_BRAIN=model with a key to have it reason, or write your
          own against the protocol.
        </p>
      </Disclosure>
    </Card>
  );
}

/** One column: a sidebar beside the agents only ever held what the header already shows. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="page mx-auto w-full max-w-[56rem] px-4 py-8 sm:px-6 sm:py-10">{children}</div>;
}
