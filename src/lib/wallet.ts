'use client';

import { encodeFunctionData, numberToHex } from 'viem';
import type { ChainInfo } from '@/lib/chains';
import { chipVaultAbi } from '@/server/vault-abi';

/**
 * Talks to whatever injected wallet the browser has, over EIP-1193 directly.
 * The wallet holds the keys and does the signing.
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
  if (!injected) throw new WalletError('Install MetaMask or another browser wallet to continue.');
  return injected;
}

/** Whether the browser has an injected wallet at all. */
export function hasWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

/**
 * Follows a change the player made inside the wallet itself.
 *
 * This keeps the interface on the network and the address the wallet is
 * actually using, which matters because the interface looks authoritative: the
 * next deposit is priced for the chain the header shows, and the session names
 * the account in front of the player.
 *
 * Returns an unsubscribe. A provider that offers zero events yields a no-op
 * one, so every caller can unsubscribe the same way.
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
  if (!address) throw new WalletError('Your wallet returned an empty account list.');
  await ensureChain(chain);
  return address;
}

export async function currentAddress(): Promise<string | null> {
  if (!hasWallet()) return null;
  const accounts = (await wallet().request({ method: 'eth_accounts' })) as string[];
  return accounts[0] ?? null;
}

/**
 * The network the wallet is on, read silently.
 *
 * Read on load, because the wallet events cover what happens while a tab
 * is open: a player who switched networks with the site closed comes back to a
 * header still naming the old one.
 */
export async function currentChainId(): Promise<number | null> {
  if (!hasWallet()) return null;
  const id = (await wallet().request({ method: 'eth_chainId' })) as string | undefined;
  return id ? Number(id) : null;
}

/**
 * Moves the wallet to a network, describing it first if the wallet is meeting
 * it for the first time. The description comes from the chain registry, so the
 * wallet adds any network the registry holds.
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

    // Adding and switching are separate. Some wallets make the new network
    // active and some leave you where you were, so the way to know is to ask, and
    // every caller here treats a resolved promise as "we are on that chain".
    if (!(await onChain(target))) {
      await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
    }
  }

  // Asked once more to confirm. A wallet can answer a switch and stay put, and
  // this check keeps the next transaction off whichever network the player was
  // already on.
  if (!(await onChain(target))) {
    throw new WalletError(`Your wallet is on another network. Switch to ${chain.name} and try again.`);
  }
}

async function onChain(target: string): Promise<boolean> {
  const current = (await wallet().request({ method: 'eth_chainId' })) as string | undefined;
  return current?.toLowerCase() === target.toLowerCase();
}

/**
 * Whether a failed switch means the wallet is meeting the network for the
 * first time.
 *
 * `4902` at the top level is what the MetaMask extension answers, and other
 * shapes are in circulation too: several wallets wrap the provider error and
 * report `-32603` with the original nested underneath. Monad is the one chain
 * in the registry that wallets add fresh, so this branch is what gives a player
 * on another wallet an add-network prompt.
 *
 * Some wallets go further and answer `-32603` with a bare sentence. The
 * sentence is matched as a last resort: guessing wrong costs one add-network
 * prompt the player can decline, and catching it gives them the network.
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
        // Named even though ensureChain has just run, because the player can
        // still switch networks while the prompt is open. A wallet refuses a
        // transaction whose chainId differs from its own, and that refusal is
        // what keeps a deposit on the chain its intent was priced for, the one
        // chain the server credits it on.
        chainId: numberToHex(options.chain.id),
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
