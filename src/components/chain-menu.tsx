'use client';

import { useState } from 'react';
import { useChain } from './chain-context';
import { useDismissed } from './ui';

/**
 * Which network the player is on, and the way to change it.
 *
 * One component for the header and the cashier, so the two look and behave
 * alike. With one chain enabled it is a badge: there is nothing to choose.
 */
export function ChainMenu({
  className = '',
  align = 'right',
  disabled = false,
}: {
  className?: string;
  /** The edge of the button the menu lines up with. */
  align?: 'left' | 'right';
  disabled?: boolean;
}) {
  const { chains, chain, loading, switching, switchChain } = useChain();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const wrapper = useDismissed(open, setOpen);

  if (loading || !chain) return null;

  return (
    <div ref={wrapper} className={`relative ${className}`}>
      {chains.length < 2 ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          {chain.shortName}
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              setOpen((value) => !value);
            }}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={`Network. Currently ${chain.name}.`}
            disabled={disabled || switching}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            {chain.shortName}
            <span aria-hidden className="text-faint">▾</span>
          </button>

          {open ? (
            <div
              role="menu"
              className={`entering absolute ${align === 'left' ? 'left-0' : 'right-0'} z-50 mt-2 w-64 rounded-card border border-line bg-surface p-1.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]`}
            >
              <p className="label px-2.5 py-2 text-faint">Network</p>
              {chains.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.key === chain.key}
                  onClick={() => {
                    setOpen(false);
                    // A refused switch opens the menu again with the reason,
                    // beside the choice that was refused.
                    switchChain(entry.key).catch((error: unknown) => {
                      setFailure(error instanceof Error ? error.message : 'That network is unavailable.');
                      setOpen(true);
                    });
                  }}
                  className={`flex w-full items-baseline gap-2 rounded-[0.375rem] px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 ${
                    entry.key === chain.key ? 'text-ink' : 'text-muted'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="mono shrink-0 text-xs text-faint">{entry.nativeCurrency.symbol}</span>
                  {entry.key === chain.key ? <span aria-hidden className="shrink-0 text-accent">●</span> : null}
                </button>
              ))}
              {failure ? <p className="px-2.5 py-2 text-xs text-danger">{failure}</p> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
