'use client';

import { useEffect, useRef, useState } from 'react';
import { chainByKey } from '@/lib/chains';
import { chipsToWei, formatChips, formatNative, purchaseRefusal } from '@/lib/economy';
import { sendDeposit } from '@/lib/wallet';
import { useAccount } from './account-context';
import { useChain } from './chain-context';
import { ChainMenu } from './chain-menu';

type Stage = 'idle' | 'signing' | 'confirming' | 'done';

export function Cashier({ onClose }: { onClose: () => void }) {
  const { account, refresh } = useAccount();
  const { chain, chains } = useChain();
  const [stage, setStage] = useState<Stage>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Kept as typed, digits only, so the field can sit empty mid-edit.
  const [amount, setAmount] = useState('10000');
  const dialog = useRef<HTMLDivElement>(null);

  // Escape closes, and Tab stays inside, so the modal holds the keyboard the
  // way it holds the eye.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // An open menu inside the dialog takes the first Escape.
        if (!event.defaultPrevented) onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = dialog.current;
      if (!panel) return;

      const focusable = [
        ...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A deposit paid for in an earlier visit and still uncredited is picked up
  // here, so the player's money survives closing the tab mid-confirmation.
  //
  // Keyed on the wallet. The account object is replaced every time the
  // balance is refreshed, and a deposit this dialog is finishing may be
  // credited by another poll still running from the dialog closed a moment
  // ago; keying on the wallet keeps this wait running through that refresh.
  const wallet = account?.address ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!wallet) return;

    void (async () => {
      try {
        const response = await fetch('/api/cashier/pending', { cache: 'no-store' });
        const body = (await response.json()) as { deposits?: Array<{ txHash: string; chainKey: string }> };
        const waiting = body.deposits?.[0];
        if (!waiting || cancelled) return;

        // Finished on the network it was paid on, whatever the player is
        // looking at now. A deposit stays on the chain it was paid on.
        const paidOn = chainByKey(waiting.chainKey);
        setStage('confirming');
        setStatus(`Finishing a deposit from earlier${paidOn ? ` on ${paidOn.shortName}` : ''}.`);
        const credited = await pollConfirm(waiting.txHash, waiting.chainKey, (message) => {
          if (!cancelled) setStatus(message);
        });
        if (cancelled) return;
        await refresh();
        setStage('done');
        setStatus(`${formatChips(credited)} chips added.`);
      } catch (error) {
        if (!cancelled) {
          setStage('idle');
          setStatus(null);
          setFailure(describe(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet, refresh]);

  async function buy(chips: number) {
    if (!account || !chain) return;
    setFailure(null);
    setStage('signing');
    setStatus('Approve the transaction in your wallet.');

    try {
      const intentResponse = await fetch('/api/cashier/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chips, chain: chain.key }),
      });
      const intent = (await intentResponse.json()) as {
        intentId?: string;
        bytes32?: `0x${string}`;
        vault?: `0x${string}`;
        valueWei?: string;
        error?: string;
      };
      if (!intentResponse.ok || !intent.bytes32) throw new Error(intent.error ?? 'The purchase failed to start. Try again.');

      const txHash = await sendDeposit({
        from: account.address,
        chain,
        vault: intent.vault!,
        intentId: intent.bytes32,
        valueWei: intent.valueWei!,
      });

      // Written down first. A deposit whose hash is on record can be finished
      // later; one whose hash lives in this tab alone needs the tab, so the
      // player is told when that is the position they are in.
      const noted = await fetch('/api/cashier/pending', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentId: intent.intentId, txHash }),
      })
        .then((response) => response.ok)
        .catch(() => false);

      setStage('confirming');
      setStatus(
        noted
          ? 'Waiting for the network to confirm.'
          : 'Waiting for the network to confirm. Keep this window open: this deposit finishes here.',
      );

      const credited = await pollConfirm(txHash, chain.key, (message) => setStatus(message));
      await refresh();
      setStage('done');
      setStatus(`${formatChips(credited)} chips added.`);
    } catch (error) {
      setStage('idle');
      setStatus(null);
      setFailure(describe(error));
    }
  }

  const busy = stage === 'signing' || stage === 'confirming';
  const symbol = chain?.nativeCurrency.symbol ?? '';
  // A chain can be switched on before its vault exists. Watching works and
  // buying opens with the vault, and the dialog says so up front.
  const settles = Boolean(chain?.vault);
  /** Whether switching would reach a working cashier. */
  const settlesSomewhere = chains.some((entry) => entry.vault);

  const chips = Number(amount);
  const refusal = purchaseRefusal(chips);
  const wei = refusal ? null : chipsToWei(chips);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Chips Store"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        // The shell holds still, so the dialog carries its own scrollbar.
        className="scroll-y max-h-full w-full max-w-lg rounded-card border border-line bg-surface shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] outline-none"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-6 py-5">
          <h2 className="text-2xl text-ink">Chips Store</h2>
          {/* Shown at every width: on a phone, where the header hides it, this
              is the way off a network whose vault is still to come. */}
          <ChainMenu align="left" disabled={busy} className="order-last basis-full sm:order-none sm:basis-auto" />
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-sm font-medium text-faint transition-colors hover:text-ink"
          >
            Close
          </button>
        </div>

        <form
          className="flex flex-col gap-4 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!refusal) void buy(chips);
          }}
        >
          <label className="flex flex-col gap-2">
            <span className="label text-faint">Amount</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              autoComplete="off"
              disabled={busy}
              className="mono h-12 rounded-control border border-line bg-surface-2 px-3 text-2xl text-ink tabular-nums outline-none focus:border-accent disabled:opacity-45"
            />
          </label>

          <p
            aria-live="polite"
            className={`mono text-[0.8125rem] tabular-nums ${wei === null ? 'text-faint' : 'text-muted'}`}
          >
            {wei === null ? refusal : `${formatNative(wei)} ${symbol}`}
          </p>

          <button
            type="submit"
            disabled={busy || !account || !settles || refusal !== null}
            className="inline-flex h-10 items-center justify-center rounded-control bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {refusal ? 'Buy chips' : `Buy ${formatChips(chips)} chips`}
          </button>
        </form>

        {chain && !settles ? (
          <div className="border-t border-line px-6 py-4">
            {/* Advice worth following. Before the first vault exists every
            network is in this same state, so the message says that plainly. */}
            <p className="text-sm text-muted">
              {settlesSomewhere
                ? `The ${chain.name} cashier opens once its vault is deployed. Pick another network above.`
                : 'The cashier opens once a vault is deployed.'}
            </p>
          </div>
        ) : null}

        {status || failure ? (
          <div className="border-t border-line px-6 py-4">
            {failure ? (
              <p className="text-sm text-danger">{failure}</p>
            ) : (
              <p className="text-sm text-muted">{status}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * How often to ask. The confirm route allows ten calls a minute, so asking any
 * at this pace keeps the cashier inside its own rate limit mid-wait.
 */
const POLL_MS = 6_000;

/**
 * A deposit is credited once the chain has confirmed it, so the cashier keeps
 * asking and shows the chips when they truly arrive.
 *
 * It keeps asking through every answer short of a refusal: a transaction still
 * being mined (202), a rate limit (429, waited out as told) and a node that
 * timed out (5xx). A 4xx the arena chose to send is what ends the wait.
 */
async function pollConfirm(txHash: string, chainKey: string, onStatus: (message: string) => void): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch('/api/cashier/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, chain: chainKey }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      status?: 'credited' | 'pending';
      chips?: number;
      confirmations?: number;
      required?: number;
      error?: string;
    };

    if (response.ok && body.status === 'credited' && typeof body.chips === 'number') return body.chips;

    let pause = POLL_MS;
    if (response.status === 202) {
      onStatus(`Waiting for the network to confirm (${body.confirmations ?? 0} of ${body.required ?? '?'}).`);
    } else if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      if (Number.isFinite(seconds) && seconds > 0) pause = seconds * 1000;
      onStatus('Waiting for the network to confirm.');
    } else if (response.status >= 500) {
      onStatus(body.error ?? 'The network is slow to answer. Trying again.');
    } else {
      throw new Error(body.error ?? 'The cashier hit an error. Try again.');
    }

    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error('Still confirming. Reopen the cashier later to finish it.');
}

function describe(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return 'Transaction rejected in your wallet.';
  if (error instanceof Error) return error.message;
  return 'The cashier hit an error. Try again.';
}
