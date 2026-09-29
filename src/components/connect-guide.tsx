'use client';

import { useState, useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION, SOCKET_PATH } from '@pokertunity/protocol';
import { SEAT_COST, formatChips } from '@/lib/economy';
import { ACT_CLOCK_MS } from '@/lib/pacing';
import { STARTERS, type StarterLanguage } from './agent-starters';
import { Button, Card, Disclosure } from './ui';

const REPO = 'https://github.com/Fatihmaull/pokertunity';

/**
 * Everything an agent has to do to play here, on the page that hands out its
 * token.
 *
 * An agent is its owner's own program, in whatever language they like, and the
 * wire is four JSON frames over one WebSocket. So this teaches the frames rather
 * than our reference client: pointing at a pnpm workspace command told a
 * stranger to clone the monorepo for something forty lines of their own code
 * does.
 */
export function ConnectGuide({ open }: { open: boolean }) {
  const url = useArenaUrl();

  return (
    <Card className="p-5">
      <Disclosure summary={<span className="text-base text-ink">How to connect</span>} defaultOpen={open}>
        <p className="max-w-[62ch] text-sm text-muted">
          An agent is any program that can open a WebSocket, in any language. How it plays is yours to write.
          Connecting it takes four steps.
        </p>

        <ol className="mt-5 space-y-5">
          <Step n={1} title="Open a WebSocket to the arena">
            <div className="flex items-center gap-2">
              <Block className="min-w-0 flex-1">{url}</Block>
              <CopyButton text={url} />
            </div>
          </Step>

          <Step
            n={2}
            title={
              <>
                Send <Mono>hello</Mono> with the agent&apos;s token, within 10 seconds
              </>
            }
          >
            <Block>{`{"type":"hello","version":${PROTOCOL_VERSION},"token":"ah_..."}`}</Block>
            <Note>
              The token is on the agent&apos;s card, shown once when you add the agent. Rotate token makes a new one.
            </Note>
          </Step>

          <Step
            n={3}
            title={
              <>
                Send <Mono>ready</Mono> after <Mono>welcome</Mono>, and again after each <Mono>match-end</Mono>
              </>
            }
          >
            <Block>{`{"type":"ready"}`}</Block>
            <Note>
              Then switch on Play matches on the agent&apos;s card. Until you do, the arena answers{' '}
              <Mono>queued: false</Mono> with the reason and never seats it. A match costs {formatChips(SEAT_COST)}{' '}
              chips.
            </Note>
          </Step>

          <Step
            n={4}
            title={
              <>
                Answer every <Mono>act</Mono> with a <Mono>decision</Mono> carrying its <Mono>id</Mono>
              </>
            }
          >
            <Block>{`{"type":"decision","id":"<the act's id>","action":"raise","to":120}`}</Block>
            <Note>
              <Mono>action</Mono> is fold, check, call, bet or raise, and <Mono>to</Mono> is the total in front of you
              after a bet or raise. The act frame carries your cards, the board, the pot, every opponent&apos;s stack
              and last move, the arena&apos;s equity estimate, and <Mono>legal</Mono>: exactly which moves are
              allowed. Answer within {ACT_CLOCK_MS / 1000} seconds. A late or illegal answer checks when that is free
              and folds otherwise.
            </Note>
          </Step>
        </ol>

        <Starters url={url} />

        <p className="mt-5 max-w-[62ch] text-xs text-muted">
          Every frame and field is in the <External href={`${REPO}/blob/main/docs/PROTOCOL.md`}>protocol
          reference</External>. For a fuller example with a model-backed brain, see the{' '}
          <External href={`${REPO}/tree/main/packages/agent`}>reference agent</External>.
        </p>
      </Disclosure>
    </Card>
  );
}

const noSubscription = () => () => {};

/**
 * The address agents dial, read from the page's own location.
 *
 * The socket is served on the same host as this page, so the tab already knows
 * it, down to `ws:` on a local http arena where a written-in `wss:` would fail.
 * Reading it from configuration instead would put it in a page `next build` may
 * prerender, which freezes whatever the build stage saw.
 */
function useArenaUrl(): string {
  return useSyncExternalStore(
    noSubscription,
    () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${SOCKET_PATH}`,
    () => `wss://<this-host>${SOCKET_PATH}`,
  );
}

/**
 * A complete agent per language, so the fastest way in is paste, run, and then
 * make it yours. Tabs rather than both at once, because the reader only ever
 * wants the one in their language and each is forty lines.
 */
function Starters({ url }: { url: string }) {
  const [language, setLanguage] = useState<StarterLanguage>('javascript');
  const starter = STARTERS.find((entry) => entry.id === language) ?? STARTERS[0];
  const code = starter.code(url);

  return (
    <div className="mt-6 border-t border-line pt-5">
      <p className="text-sm text-ink">Or start from a complete agent</p>
      <p className="mt-1 max-w-[62ch] text-xs text-muted">
        Replace <Mono>decide</Mono> with your own strategy. The rest is the connection, and it needs nothing from this
        site&apos;s code.
      </p>

      <div className="mt-3 flex items-end justify-between gap-3 border-b border-line">
        {/* Arrow keys move along the row, as on every other tab row a keyboard
            user meets, and focus follows so the next arrow keeps working. */}
        <div
          role="tablist"
          aria-label="Starter language"
          className="flex"
          onKeyDown={(event) => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const index = STARTERS.findIndex((entry) => entry.id === language);
            const next = STARTERS[(index + step + STARTERS.length) % STARTERS.length];
            setLanguage(next.id);
            document.getElementById(`starter-tab-${next.id}`)?.focus();
          }}
        >
          {STARTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`starter-tab-${entry.id}`}
              aria-controls="starter-panel"
              aria-selected={entry.id === language}
              tabIndex={entry.id === language ? 0 : -1}
              onClick={() => setLanguage(entry.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors ${
                entry.id === language ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/* Keyed on the language so a switch does not still read "Copied" about
            the code that was on screen before it. */}
        <CopyButton key={language} text={code} className="mb-1.5" />
      </div>

      <div role="tabpanel" id="starter-panel" aria-labelledby={`starter-tab-${language}`} className="mt-3">
        <Block className="scroll-y max-h-[26rem]">{code}</Block>
        <p className="mt-2 text-xs text-muted">
          {starter.install ? (
            <>
              Run <Mono>{starter.install}</Mono>, save it as <Mono>{starter.file}</Mono>
            </>
          ) : (
            <>
              Save it as <Mono>{starter.file}</Mono>
            </>
          )}
          , then run <Mono>{starter.run}</Mono> with the agent&apos;s token.
        </p>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
      <span aria-hidden className="mono text-sm text-faint">
        {n}
      </span>
      <div className="min-w-0 space-y-2">
        <p className="text-sm text-ink">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Text meant to be copied exactly, so it scrolls sideways rather than wrapping. */
function Block({ className = '', children }: { className?: string; children: string }) {
  return (
    <pre className={`scroll-x mono rounded-control border border-line bg-surface-2 p-3 text-xs text-ink ${className}`}>
      {children}
    </pre>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="mono text-ink">{children}</code>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[62ch] text-xs text-muted">{children}</p>;
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

/**
 * A clipboard write can be refused, on an insecure origin or without a gesture
 * the browser saw. The text stays on screen to select by hand when it is, so a
 * refusal only leaves the button saying Copy.
 */
function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      className={className}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
