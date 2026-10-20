import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  type Chain,
  type Hash,
  type PublicClient,
} from 'viem';
import { vaultAddress, type DeployedChain } from './chains';
import { chipVaultAbi } from './vault-abi';

/**
 * Chain access, for whichever chain the caller names.
 *
 * The viem chain is built from this deployment's own registry, so any chain
 * works as soon as it has a row in `src/lib/chains.ts`.
 *
 * Read-only by design: the running server holds a public client alone. The
 * treasury key belongs to the vault deploy script.
 */

/** Confirmations required before a deposit is credited. Three, for finality. */
export const REQUIRED_CONFIRMATIONS = 3n;

const chainDefinitions = new Map<number, Chain>();
const publicClients = new Map<number, PublicClient>();

export function chainDefinition(chain: DeployedChain): Chain {
  let existing = chainDefinitions.get(chain.id);
  if (!existing) {
    existing = defineChain({
      id: chain.id,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: [chain.rpcUrl] } },
      blockExplorers: { default: chain.explorer },
      testnet: chain.testnet,
    });
    chainDefinitions.set(chain.id, existing);
  }
  return existing;
}

export function publicClientFor(chain: DeployedChain): PublicClient {
  let existing = publicClients.get(chain.id);
  if (!existing) {
    existing = createPublicClient({ chain: chainDefinition(chain), transport: http(chain.rpcUrl) });
    publicClients.set(chain.id, existing);
  }
  return existing;
}


export interface ObservedDeposit {
  payer: `0x${string}`;
  intentId: `0x${string}`;
  amountWei: bigint;
  blockNumber: bigint;
  /** Position of this deposit's log in the block, which tells two deposits in one transaction apart. */
  logIndex: number;
  confirmations: bigint;
}

/**
 * Reads a deposit back off the chain, or null while it is still being mined.
 *
 * The caller supplies the transaction hash and the chain supplies the rest. The
 * receipt is fetched over our own RPC, the log comes from that chain's vault,
 * and the payer and amount are taken from the event itself.
 *
 * Still being mined is the ordinary first answer: the cashier asks the moment
 * the wallet hands back a hash, before any node holds a receipt for it. Null
 * keeps the cashier waiting for a deposit that is on its way.
 */
export async function observeDeposit(chain: DeployedChain, txHash: Hash): Promise<ObservedDeposit[] | null> {
  const client = publicClientFor(chain);
  const vault = vaultAddress(chain).toLowerCase();

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
  if (receipt.status !== 'success') return [];

  const head = await client.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;

  // Every deposit in the transaction. One call can carry several intents,
  // and returning all of them credits each one whose chips are in the vault.
  const found: ObservedDeposit[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault) continue;

    let decoded;
    try {
      decoded = decodeEventLog({ abi: chipVaultAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'Deposited') continue;

    const args = decoded.args as unknown as { payer: `0x${string}`; intentId: `0x${string}`; amount: bigint };
    found.push({
      payer: args.payer,
      intentId: args.intentId,
      amountWei: args.amount,
      blockNumber: receipt.blockNumber,
      logIndex: log.logIndex,
      confirmations,
    });
  }

  return found;
}
