'use client';

import { useEffect, useRef, useState } from 'react';
import { chainByKey } from '@/lib/chains';
import { chipsToWei, formatChips, formatNative, formatUsd, purchaseRefusal } from '@/lib/economy';
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

  // Escape closes, and Tab stays inside. A modal the keyboard can walk out of
  // while the page behind it is still there is a modal in appearance only.
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

  // A deposit paid for in an earlier visit and never credited is picked up
  // here, so closing the tab while it confirmed does not cost the player money.
  //
  // Keyed on the wallet, not on the account object. The account is replaced
  // every time the balance is refreshed, and a deposit this dialog is finishing
  // may be credited by another poll still running from the dialog closed a
  // moment ago, whose refresh would cancel this one mid-wait and leave the
  // dialog on "Waiting for the network" with Buy disabled.
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
        // looking at now. A deposit does not follow them between chains.
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
      if (!intentResponse.ok || !intent.bytes32) throw new Error(intent.error ?? 'Could not start the purchase.');

      const txHash = await sendDeposit({
        from: account.address,
        chain,
        vault: intent.vault!,
        intentId: intent.bytes32,
        valueWei: intent.valueWei!,
      });

      // Written down before anything else can fail. A deposit whose hash is on
      // record can be finished later; one whose hash was only ever in this tab
      // cannot, so the player is told when that is the position they are in.
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
          : 'Waiting for the network to confirm. Keep this window open: the deposit could not be saved to finish later.',
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
  // A chain can be switched on before its vault exists. Watching still works;
  // buying does not, and the dialog says so rather than failing at the wallet.
  const settles = Boolean(chain?.vault);
  /** Whether switching would reach a cashier that works, or only the same message again. */
  const settlesSomewhere = chains.some((entry) => entry.vault);

  const chips = Number(amount);
  const refusal = purchaseRefusal(chips);
  const wei = refusal ? null : chipsToWei(chips);
  const usd = wei === null ? null : formatUsd(wei, chain?.notionalUsd);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Cashier"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        // The shell does not scroll, so the dialog carries its own scrollbar rather
        // than relying on the page to make room for it.
        className="scroll-y max-h-full w-full max-w-lg rounded-card border border-line bg-surface shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] outline-none"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-6 py-5">
          <h2 className="text-2xl text-ink">Cashier</h2>
          <p className="mono text-xs text-faint">1 chip = 0.00001 {symbol || 'native token'}</p>
          {/* Shown at every width: on a phone, where the header hides it, this
              is the way off a network that has no vault. */}
          <ChainMenu align="left" disabled={busy} />
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
            <span className="label text-faint">Chips</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              autoComplete="off"
              disabled={busy}
              className="mono h-12 rounded-control border border-line bg-surface-2 px-3 text-2xl text-ink tabular-nums outline-none focus:border-accent disabled:opacity-45"
            />
          </label>

          <div aria-live="polite" className="mono min-h-10 tabular-nums">
            {wei === null ? (
              <p className="text-[0.8125rem] text-faint">{refusal}</p>
            ) : (
              <>
                <p className="text-[0.8125rem] text-muted">
                  {formatNative(wei)} {symbol}
                </p>
                {usd ? <p className="text-xs text-faint">{usd} at a fixed testnet rate</p> : null}
              </>
            )}
          </div>

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
            {/* Advice worth following, or none. Before the first vault exists
                every network is in this same state, and sending the player
                round the header to read the identical sentence three times is
                worse than telling them plainly that there is nowhere to go. */}
            <p className="text-sm text-muted">
              {settlesSomewhere
                ? `No vault on ${chain.name} yet. Pick another network above.`
                : 'Chips cannot be bought yet: no vault is deployed.'}
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
 * faster than this runs the cashier into its own rate limit mid-wait.
 */
const POLL_MS = 6_000;

/**
 * A deposit is credited only once the chain has confirmed it, so the cashier
 * keeps asking rather than pretending the chips have arrived.
 *
 * It keeps asking through everything that is not a refusal: a transaction still
 * being mined (202), a rate limit (429, waited out as told) and a node that did
 * not answer (5xx). Only a 4xx the arena chose to send ends the wait.
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
      onStatus(body.error ?? 'The network did not answer. Trying again.');
    } else {
      throw new Error(body.error ?? 'The cashier could not complete that.');
    }

    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error('Not confirmed yet. Reopen the cashier later to finish it.');
}

function describe(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return 'Transaction rejected in your wallet.';
  if (error instanceof Error) return error.message;
  return 'The cashier could not complete that.';
}
