'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicChain } from '@/lib/chains';
import { currentChainId, ensureChain, hasWallet, watchWallet } from '@/lib/wallet';

/**
 * Which network the player is on, for the whole interface.
 *
 * The list comes from the server rather than from a constant here, so this
 * build runs against whatever chains the deployment enabled. Until it arrives
 * the active chain is null and anything that would move money stays disabled,
 * which is better than guessing a network and sending a deposit to it.
 */

interface ChainContextValue {
  chains: PublicChain[];
  chain: PublicChain | null;
  loading: boolean;
  switching: boolean;
  switchChain(key: string): Promise<void>;
}

const Context = createContext<ChainContextValue | null>(null);

interface ChainsResponse {
  chains: PublicChain[];
  active: string;
}

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [chains, setChains] = useState<PublicChain[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/chains', { cache: 'no-store' })
      .then((response) => response.json() as Promise<ChainsResponse>)
      .then((body) => {
        if (cancelled) return;
        setChains(body.chains ?? []);
        setActive(body.active ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchChain = useCallback(
    async (key: string) => {
      const target = chains.find((entry) => entry.key === key);
      if (!target || key === active) return;

      setSwitching(true);
      try {
        const response = await fetch('/api/chains', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chain: key }),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? 'That network is unavailable.');
        }
        setActive(key);

        // The wallet is moved too, but its refusal is not a failure: watching a
        // table needs no wallet, and the next transaction asks again anyway.
        if (hasWallet()) await ensureChain(target).catch(() => {});
      } finally {
        setSwitching(false);
      }
    },
    [chains, active],
  );

  /**
   * Follows the wallet when the player switches network inside it.
   *
   * The cookie is what prices a deposit, so leaving it behind means the next
   * purchase is issued for the chain the header still shows and `ensureChain`
   * then drags the wallet back — which reads as the site overruling a choice
   * the player just made.
   *
   * A wallet that moves to a network this deployment does not settle on is
   * left alone: there is no cookie value that describes it, and the cashier
   * already refuses anything it cannot price.
   */
  const follow = useCallback(
    (id: number | null) => {
      const moved = chains.find((entry) => entry.id === id);
      if (!moved || moved.key === active) return;

      setActive(moved.key);
      void fetch('/api/chains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain: moved.key }),
      }).catch(() => {
        // The header is already following the wallet. A cookie that failed to
        // follow is re-sent by the next switch, and every money path resolves
        // the chain again on the server anyway.
      });
    },
    [chains, active],
  );

  useEffect(() => {
    if (chains.length === 0) return;
    return watchWallet('chainChanged', (...args) => {
      const [id] = args as [string | undefined];
      follow(id ? Number(id) : null);
    });
  }, [chains, follow]);

  // The events above only see changes made while a tab is open. A player who
  // switched with the site closed comes back to a cookie naming the old
  // network, so the wallet is asked once on load, silently: `eth_chainId`
  // opens no prompt and works before any account is connected.
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current || chains.length === 0 || active === null || !hasWallet()) return;
    reconciled.current = true;
    currentChainId()
      .then(follow)
      .catch(() => {});
  }, [chains, active, follow]);

  const value = useMemo<ChainContextValue>(() => {
    const current = chains.find((entry) => entry.key === active) ?? null;
    return { chains, chain: current, loading, switching, switchChain };
  }, [chains, active, loading, switching, switchChain]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChain(): ChainContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useChain must be used inside ChainProvider');
  return value;
}
