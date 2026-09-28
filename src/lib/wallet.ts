'use client';

import { encodeFunctionData, numberToHex } from 'viem';
import type { ChainInfo } from '@/lib/chains';
import { chipVaultAbi } from '@/server/vault-abi';

/**
 * Talks to whatever injected wallet the browser has, over EIP-1193 directly.
 * Nothing here holds a key or signs anything itself.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {}

function wallet(): Eip1193Provider {
  const injected = typeof window === 'undefined' ? undefined : window.ethereum;
  if (!injected) throw new WalletError('No wallet found. Install MetaMask or another browser wallet to continue.');
  return injected;
}

/** Whether the browser has an injected wallet at all. */
export function hasWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

/**
 * Follows a change the player made inside the wallet rather than through us.
 *
 * Without this the interface keeps claiming a network and an address the
 * wallet has already left, which is the worst kind of wrong because it looks
 * authoritative: the next deposit is priced for the chain the header shows,
 * and the session goes on naming an account nobody is looking at.
 *
 * Returns an unsubscribe. A provider that offers no events yields one that
 * does nothing, so a caller never has to ask whether it worked.
 */
export function watchWallet(
  event: 'chainChanged' | 'accountsChanged',
  handler: (...args: unknown[]) => void,
): () => void {
  const injected = typeof window === 'undefined' ? undefined : window.ethereum;
  if (!injected?.on) return () => {};

  injected.on(event, handler);
  return () => injected.removeListener?.(event, handler);
}

export async function connect(chain: ChainInfo): Promise<string> {
  const accounts = (await wallet().request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new WalletError('Your wallet returned no account.');
  await ensureChain(chain);
  return address;
}

export async function currentAddress(): Promise<string | null> {
  if (!hasWallet()) return null;
  const accounts = (await wallet().request({ method: 'eth_accounts' })) as string[];
  return accounts[0] ?? null;
}

/**
 * The network the wallet is on, without asking the player anything.
 *
 * Read on load, because the wallet events only cover what happens while a tab
 * is open: a player who switched networks with the site closed comes back to a
 * header still naming the old one.
 */
export async function currentChainId(): Promise<number | null> {
  if (!hasWallet()) return null;
  const id = (await wallet().request({ method: 'eth_chainId' })) as string | undefined;
  return id ? Number(id) : null;
}

/**
 * Moves the wallet to a network, describing it first if the wallet has never
 * heard of it. The description comes from the chain registry, so a network the
 * wallet does not ship with is added rather than refused.
 */
export async function ensureChain(chain: ChainInfo): Promise<void> {
  const target = numberToHex(chain.id);
  if (await onChain(target)) return;

  try {
    await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  } catch (error) {
    if (!isUnknownChain(error)) throw error;

    await wallet().request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: target,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [chain.defaultRpcUrl],
          blockExplorerUrls: [chain.explorer.url],
        },
      ],
    });

    // Adding is not switching. Some wallets make the new network active and
    // some leave you where you were, so the only way to know is to ask, and
    // every caller here treats a resolved promise as "we are on that chain".
    if (!(await onChain(target))) {
      await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
    }
  }

  // Asked once more rather than assumed. A wallet that answers a switch
  // without performing one would otherwise send the next transaction to
  // whichever network the player was already on.
  if (!(await onChain(target))) {
    throw new WalletError(`Your wallet is not on ${chain.name}. Switch to it and try again.`);
  }
}

async function onChain(target: string): Promise<boolean> {
  const current = (await wallet().request({ method: 'eth_chainId' })) as string | undefined;
  return current?.toLowerCase() === target.toLowerCase();
}

/**
 * Whether a failed switch means the wallet has never heard of the network.
 *
 * `4902` at the top level is what the MetaMask extension answers, and it is
 * not the only shape in circulation: several wallets wrap the provider error
 * and report `-32603` with the original nested underneath. Monad is the one
 * chain in the registry that no wallet ships with, so this branch is the only
 * thing standing between a player on another wallet and a raw provider error.
 *
 * Some wallets go further and answer `-32603` with only a sentence, no code
 * anywhere in the chain. The sentence is matched as a last resort: guessing
 * wrong costs one add-network prompt the player can decline, while missing it
 * costs them the network.
 */
export function isUnknownChain(error: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = error;

  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const shape = node as { code?: number; data?: unknown; originalError?: unknown; cause?: unknown };
    if (shape.code === 4902) return true;
    const said = (node as { message?: unknown }).message;
    if (typeof said === 'string' && UNKNOWN_CHAIN_MESSAGE.test(said)) return true;
    node = shape.originalError ?? shape.cause ?? (shape.data as { originalError?: unknown })?.originalError ?? shape.data;
  }

  return false;
}

const UNKNOWN_CHAIN_MESSAGE = /unrecognized chain|unknown chain|chain .*(?:has not been added|not been added|not added)|try adding the chain/i;

export async function signMessage(address: string, message: string): Promise<string> {
  return (await wallet().request({ method: 'personal_sign', params: [message, address] })) as string;
}

/** Sends the buy-in to the vault with the intent the server issued. */
export async function sendDeposit(options: {
  from: string;
  chain: ChainInfo;
  vault: `0x${string}`;
  intentId: `0x${string}`;
  valueWei: string;
}): Promise<string> {
  await ensureChain(options.chain);

  const data = encodeFunctionData({
    abi: chipVaultAbi,
    functionName: 'deposit',
    args: [options.intentId],
  });

  return (await wallet().request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: options.from,
        to: options.vault,
        value: numberToHex(BigInt(options.valueWei)),
        data,
      },
    ],
  })) as string;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
