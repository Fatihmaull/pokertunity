'use client';

import { useEffect, useRef, useState } from 'react';
import { SEAT_COST, formatChips } from '@/lib/economy';
import { formatSigned } from '@/lib/format';
import type { AgentSummary } from '@/server/actions';
import { useAccount } from './account-context';
import { ChipDot } from './table-art';
import { AxesCard } from './axes-card';
import { OnChainPanel } from './onchain';
import { Cashier } from './cashier';
import { ConnectGuide } from './connect-guide';
import { Badge, Button, ButtonLink, Card, Disclosure, EmptyState, PageHeader, Stat } from './ui';

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
        <Card className="mt-4 p-8 sm:p-12">
          <h1 className="display max-w-[20ch] text-[2rem] text-ink sm:text-[2.5rem]">
            Register an agent and get its token.
          </h1>
          <p className="mt-4 max-w-[56ch] text-base text-muted">
            Connect a wallet first. It takes one signature.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
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
      <PageHeader
        title="Your agents"
        sub="Each agent connects to the arena over a socket using its own token. It plays when it is connected and has asked for a game."
        // With no agents yet the empty card below carries this button, so
        // the page does not offer the same action twice.
        action={
          account.agents.length > 0 ? (
            <Button tone="primary" onClick={() => void addAgent()} disabled={busy}>
              Add an agent
            </Button>
          ) : null
        }
      />

      {failure ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {failure}
        </p>
      ) : null}

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
          <Card>
            <EmptyState
              title="No agents yet"
              body="Add one to get its token."
              action={
                <Button tone="primary" onClick={() => void addAgent()} disabled={busy}>
                  Add an agent
                </Button>
              }
            />
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

        <ConnectGuide />
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
  agent: AgentSummary;
  busy: boolean;
  affordable: boolean;
  token: string | null;
  onRotate: () => void;
  onRename: (name: string) => void;
  onQueue: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? agent.name;

  return (
    <Card className="p-5">
      {/* Who it is and when it was last heard from on the left; what it is
          doing and the one switch that changes that on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChipDot color={agent.color} size={22} />
          <div className="min-w-0">
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
              className="-ml-2 h-8 w-full max-w-[18rem] rounded-control border border-transparent bg-transparent px-2 text-lg text-ink outline-none hover:border-line focus:border-accent focus:bg-surface-2"
            />
            {/* History, for an agent that has dropped: the badge says what it
                is doing now, this says why it stopped. Connected, or never
                connected, there is nothing here the badge has not said. */}
            {!agent.connected && agent.lastSeenAt ? (
              <p className="text-xs text-faint">
                {agent.lastCloseReason
                  ? `Last disconnect: ${agent.lastCloseReason}`
                  : `Last connected ${new Date(agent.lastSeenAt).toLocaleString('en-US')}`}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Status agent={agent} affordable={affordable} />
          <QueueSwitch agent={agent} disabled={busy} onChange={onQueue} />
        </div>
      </div>

      {/* The token belongs to the agent named just above it, so it sits under
          that name rather than among the figures, on the card's left edge
          like everything else below the header. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onRotate} disabled={busy}>
          Rotate token
        </Button>
        {/*
          Keyed on the token so a second rotation starts fresh: not still
          reading "Copied" from the first.
        */}
        <TokenField key={token ?? 'hidden'} token={token} />
      </div>

      {/*
        Rotation refuses the old token on the next connection and leaves the one
        already open alone. Whoever rotated because the token leaked needs to
        hear that here, or they walk away believing the leak is closed. The
        remedy is connecting on the new token, because a second connection for
        an agent replaces the first and the seat belongs to the agent.
      */}
      {token && agent.connected ? (
        <p className="mt-2 text-xs text-muted">
          The open connection still uses the old token. Restart your agent with this one to close it.
        </p>
      ) : null}

      <TableRecord
        hands={agent.handsPlayed}
        handsWon={agent.handsWon}
        matches={agent.matchesPlayed}
        rating={agent.rating}
        net={agent.chipsWon}
      />

      {agent.seat ? (
        <ButtonLink href={`/match/${agent.seat.matchId}`} tone="primary" size="sm" className="mt-5">
          Watch it play
        </ButtonLink>
      ) : null}

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

/**
 * What an agent has done at the table, under one rule for every figure.
 *
 * A count is a number, and zero is a real answer to it. A figure that does not
 * exist yet, like a rating before any match has finished, is a dash, and the
 * Matches tile beside it is reason enough without a sentence. A hint that would
 * describe nothing, a win rate over no hands, is left off rather than dashed. A
 * change carries a sign only when it is one. The row is there from the first
 * visit, so a new agent's card has the same shape it will have once it plays.
 */
function TableRecord({
  hands,
  handsWon,
  matches,
  rating,
  net,
}: {
  hands: number;
  handsWon: number;
  matches: number;
  rating: number;
  net: number;
}) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
      <Stat label="Rating" value={matches > 0 ? rating.toFixed(1) : <span className="text-faint">—</span>} />
      {/* Beside the rating because it is what the rating is made of. */}
      <Stat label="Matches" value={formatChips(matches)} />
      <Stat
        label="Hands"
        value={formatChips(hands)}
        hint={hands > 0 ? `${Math.round((handsWon / hands) * 100)}% won` : undefined}
      />
      <Stat label="Net chips" value={<span className={net < 0 ? 'text-danger' : ''}>{formatSigned(net)}</span>} />
    </dl>
  );
}

/**
 * The agent's token, at the one moment it can be shown, and the way to get
 * there the rest of the time.
 *
 * Only the hash is stored, so the real token is on screen once, right after
 * minting. The rest of the time the box says how to see one, and says "new"
 * because rotating replaces the token rather than revealing it. The box is
 * always there so the card does not change shape when a token arrives, and so
 * an owner who lost theirs can see where one goes and which button makes it.
 *
 * Minting made the display the least forgiving interaction in the product:
 * 46 characters in a box that scrolls under your finger, with no second
 * chance. The input is the fallback rather than the decoration. A clipboard
 * write can be refused — an insecure origin, a browser that wants a user
 * gesture it did not see — and when it is, a real field the player can select
 * from is the difference between an inconvenience and a lost token.
 */
function TokenField({ token }: { token: string | null }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // A new agent's card is added at the foot of the list, often below the fold
  // of the button that made it. Brought into view and selected, the token is
  // one Ctrl+C away wherever the owner clicked from.
  useEffect(() => {
    if (!token) return;
    field.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.current?.focus({ preventScroll: true });
  }, [token]);

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Left for the player to select by hand, which is why it is an input.
      setCopied(false);
    }
  }

  // Beside Rotate token where there is width, under it on a phone, with the
  // field and its Copy button kept together either way. Disabled until there
  // is a token, so the empty box takes no focus and no caret.
  return (
    <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
      <input
        ref={field}
        readOnly
        disabled={!token}
        value={token ?? ''}
        placeholder="Rotate to see a new token"
        aria-label={token ? 'New agent token' : 'Agent token, hidden'}
        onFocus={token ? (event) => event.currentTarget.select() : undefined}
        className={`h-8 min-w-0 flex-1 rounded-control border px-2 text-xs ${
          token ? 'mono border-accent/40 bg-accent/5 text-accent' : 'border-line bg-surface-2 placeholder:text-faint'
        }`}
      />
      <Button size="sm" tone={token ? 'primary' : 'secondary'} onClick={copy} disabled={!token}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Status({ agent, affordable }: { agent: AgentSummary; affordable: boolean }) {
  if (agent.seat) return <Badge tone="accent">In a match</Badge>;
  if (!agent.connected) return <Badge>{agent.lastSeenAt ? 'Not connected' : 'Never connected'}</Badge>;
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
 * stops the next match; every seat plays its current one to the end.
 */
function QueueSwitch({
  agent,
  disabled,
  onChange,
}: {
  agent: AgentSummary;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const on = agent.queueEnabled;
  // What flipping it would mean, for whoever wonders. The badge beside it
  // already says what it is doing now, so this does not need a line of its own.
  const hint =
    on && agent.seat ? 'Turning this off takes effect after this match.' : `${formatChips(SEAT_COST)} per match.`;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`Play matches: ${agent.name}`}
      title={hint}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="inline-flex items-center gap-2.5 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
    >
      Play matches
      {/* The thumb is placed absolutely from the track's centre line rather
          than left in the flow, so it sits dead centre whatever the border and
          line box around it add up to. */}
      <span
        aria-hidden
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3'
        }`}
      >
        <span
          className={`absolute top-1/2 left-0.5 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-transform ${
            on ? 'translate-x-4 bg-accent-ink' : 'translate-x-0 bg-muted'
          }`}
        />
      </span>
    </button>
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
function unusedName(agents: readonly AgentSummary[]): string {
  const taken = new Set(agents.map((agent) => agent.name.toLowerCase()));
  let n = agents.length + 1;
  while (taken.has(`agent ${n}`)) n += 1;
  return `Agent ${n}`;
}

/**
 * One column: a sidebar beside the agents only ever held what the header
 * already shows. The column is narrow for reading but starts on the same left
 * edge as every other page, so the title does not jump sideways on the way in.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <div className="max-w-[56rem]">{children}</div>
    </div>
  );
}
