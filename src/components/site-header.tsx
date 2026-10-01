'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';
import { formatChips } from '@/lib/economy';
import { shortAddress } from '@/lib/wallet';
import { useAccount } from './account-context';
import { Cashier } from './cashier';
import { ChainMenu } from './chain-menu';
import { LogoMark } from './logo';
import { Button, useDismissed } from './ui';

/*
  Each label is the title of the page it opens, so a link and the heading it
  lands on never disagree.
*/
const NAV = [
  { href: '/', label: 'Home' },
  { href: '/matches', label: 'Matches' },
  { href: '/standings', label: 'Standings' },
  { href: '/agent', label: 'Your agents' },
];

/**
 * The one persistent bar. It answers, left to right, the three questions a
 * player has on every screen: where am I, where else can I go, and how many
 * chips do I have.
 */
export function SiteHeader() {
  const { account, connecting, error, signIn, signOut, dismissError } = useAccount();
  const [cashierOpen, setCashierOpen] = useState(false);
  const pathname = usePathname();

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-md">
        {/*
          Below the lg breakpoint the four labels need more width than the row
          has beside the balance and the wallet, so there they fold into a
          menu at its end.
        */}
        <div className="mx-auto flex h-[var(--header-h)] w-full max-w-[84rem] items-center gap-x-2 px-4 sm:gap-x-6 sm:px-6">
          {/*
            The only thing in the row that gives way. The name wraps onto a
            second line the link's height clips, so it shows wherever it fits
            and leaves the mark alone on a narrow phone holding a big balance.
          */}
          <Link
            href="/"
            className="flex h-[1.6em] min-w-0 flex-wrap items-center gap-x-2 overflow-hidden text-[0.9375rem] font-semibold text-ink"
          >
            <LogoMark />
            <span>Pokertunity</span>
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex">
            <NavLinks pathname={pathname} className="px-3 py-1.5 text-sm" />
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ChainMenu className="hidden lg:block" />

            {account ? (
              <>
                <button
                  type="button"
                  onClick={() => setCashierOpen(true)}
                  aria-label={`Chips Store. Balance ${formatChips(account.chips)} chips.`}
                  className="inline-flex h-9 items-center gap-2 rounded-control border border-line-strong bg-surface-2 pr-2 pl-3 text-sm transition-colors hover:bg-surface-3"
                >
                  <span className="mono text-ink tabular-nums">{formatChips(account.chips)}</span>
                  <span className="hidden text-xs text-faint sm:inline">chips</span>
                  <span className="rounded-[0.3125rem] bg-accent px-2 py-1 text-xs font-semibold text-accent-ink">
                    Buy
                  </span>
                </button>
                <WalletMenu address={account.address} onSignOut={() => void signOut()} />
              </>
            ) : (
              <Button tone="primary" onClick={() => void signIn()} disabled={connecting}>
                <span className="sm:hidden">{connecting ? 'Check wallet' : 'Connect'}</span>
                <span className="hidden sm:inline">{connecting ? 'Check your wallet' : 'Connect wallet'}</span>
              </Button>
            )}

            <NavMenu pathname={pathname} />
          </div>
        </div>
      </header>

      {error ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <div
            role="alert"
            className="entering pointer-events-auto flex max-w-[40rem] items-start gap-4 rounded-card border border-danger/40 bg-surface px-4 py-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]"
          >
            <p className="text-sm text-ink">{error}</p>
            <button
              type="button"
              onClick={dismissError}
              className="shrink-0 text-sm font-medium text-muted transition-colors hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {cashierOpen ? <Cashier onClose={() => setCashierOpen(false)} /> : null}
    </>
  );
}

function NavLinks({
  pathname,
  className,
  onClick,
}: {
  pathname: string;
  className: string;
  onClick?: () => void;
}) {
  return NAV.map((item) => {
    const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={`rounded-control font-medium whitespace-nowrap transition-colors ${className} ${
          active ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
        }`}
      >
        {item.label}
      </Link>
    );
  });
}

/** The navigation below the lg breakpoint, dropped down under the header from a button. */
function NavMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const wrapper = useDismissed(open, setOpen);
  const id = useId();

  return (
    // Left unpositioned, so the open list hangs from the header and spans its
    // full width.
    <div ref={wrapper} className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        aria-label="Menu"
        className="inline-flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface text-muted transition-colors hover:text-ink"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
          <path
            d={open ? 'M4 4l8 8M12 4l-8 8' : 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11'}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open ? (
        <nav
          id={id}
          aria-label="Main"
          className="entering absolute inset-x-0 top-full flex flex-col gap-1 border-y border-line bg-canvas px-4 py-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] sm:px-6"
        >
          <NavLinks pathname={pathname} onClick={() => setOpen(false)} className="px-3 py-2.5 text-[0.9375rem]" />
        </nav>
      ) : null}
    </div>
  );
}

function WalletMenu({ address, onSignOut }: { address: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapper = useDismissed(open, setOpen);

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        // On a phone the address is hidden and only the dot is left, which
        // names nothing to a screen reader without this.
        aria-label={`Wallet ${shortAddress(address)}`}
        className="mono inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-[0.8125rem] text-muted transition-colors hover:text-ink"
      >
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
        <span className="hidden sm:inline">{shortAddress(address)}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="entering absolute right-0 z-50 mt-2 w-60 rounded-card border border-line bg-surface p-1.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]"
        >
          <div className="px-2.5 py-2">
            <p className="label text-faint">Wallet</p>
            <p className="mono mt-1 text-xs break-all text-muted">{address}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="w-full rounded-[0.375rem] px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
