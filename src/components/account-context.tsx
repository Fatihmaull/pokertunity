'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { connect, currentAddress, ensureChain, signMessage, watchWallet, WalletError } from '@/lib/wallet';
import type { Account } from '@/server/actions';
import { useChain } from './chain-context';

interface AccountContextValue {
  account: Account | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  dismissError(): void;
}

const Context = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { chain } = useChain();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/account', { cache: 'no-store' });
    // A route that throws answers 500 with an empty body, so the status is
    // checked first and the reader gets a plain sentence.
    if (!response.ok) throw new Error('Your account failed to load. Try again in a moment.');
    const body = (await response.json()) as { session: unknown; account?: Account };
    setAccount(body.session && body.account ? body.account : null);
    setLoading(false);
  }, []);

  // The session lives on the server, so it is read once on mount and applied in
  // a callback, after the effect body runs.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/account', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`account ${response.status}`);
        return response.json() as Promise<{ session: unknown; account?: Account }>;
      })
      .then((body) => {
        if (cancelled) return;
        setAccount(body.session && body.account ? body.account : null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      // Signing in puts the wallet on the network the server will name in the
      // message, so the two agree on the first transaction.
      if (!chain) throw new Error('Still loading the available networks. Try again in a moment.');

      // The network is settled whichever way the address arrives. `connect()`
      // does it on the way in, and a wallet that has approved this origin
      // before skips that path, so settling it here keeps every sign-in after
      // the first on the network the signed message names.
      const existing = await currentAddress();
      const address = existing ?? (await connect(chain));
      if (existing) await ensureChain(chain);

      const nonceResponse = await fetch(`/api/auth/nonce?address=${address}`, { cache: 'no-store' });
      const nonceBody = (await nonceResponse.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!nonceResponse.ok || !nonceBody.message) throw new Error(nonceBody.error ?? 'Sign-in failed to start. Try again.');

      // Signed exactly as the server wrote it, verbatim,
      // so the domain, chain and nonce checked on verify are the ones signed.
      const message = nonceBody.message;
      const signature = await signMessage(address, message);

      const verify = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });

      if (!verify.ok) {
        const body = (await verify.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Sign-in failed.');
      }

      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setConnecting(false);
    }
  }, [refresh, chain]);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAccount(null);
  }, []);

  /**
   * The session names one address. When the wallet stops pointing at it, the
   * honest thing is to stop claiming it.
   *
   * Signing out, because the session belongs to the old account and the new
   * one needs a fresh signature. That keeps every screen showing the chips and
   * agents of the wallet that is actually on screen.
   */
  useEffect(() => {
    const signedInAs = account?.address;
    if (!signedInAs) return;

    return watchWallet('accountsChanged', (...args) => {
      const [accounts] = args as [string[] | undefined];
      const now = accounts?.[0];
      if (now && now.toLowerCase() === signedInAs.toLowerCase()) return;
      void signOut();
    });
  }, [account?.address, signOut]);

  // The listener above hears changes made while a tab is open. A player who
  // switched accounts with the site closed comes back signed in as the old
  // one, so the wallet is asked once, silently: `eth_accounts` is
  // prompt-free. A wallet that reports an empty account list is locked, and
  // is left alone, so stepping away keeps people signed in.
  const checkedAccount = useRef(false);
  useEffect(() => {
    const signedInAs = account?.address;
    if (checkedAccount.current || !signedInAs) return;
    checkedAccount.current = true;
    currentAddress()
      .then((now) => {
        if (now && now.toLowerCase() !== signedInAs.toLowerCase()) void signOut();
      })
      .catch(() => {});
  }, [account?.address, signOut]);

  const value = useMemo<AccountContextValue>(
    () => ({
      account,
      loading,
      connecting,
      error,
      signIn,
      signOut,
      refresh,
      dismissError: () => setError(null),
    }),
    [account, loading, connecting, error, signIn, signOut, refresh],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useAccount must be used inside AccountProvider');
  return value;
}

function describe(cause: unknown): string {
  if (cause instanceof WalletError) return cause.message;
  const code = (cause as { code?: number })?.code;
  if (code === 4001) return 'Sign-in cancelled.';
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong connecting your wallet.';
}
