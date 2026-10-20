import { redirect } from 'next/navigation';
import { UnknownChain, clearChainChoice, selectChain } from '@/server/chains';

/**
 * A link that lands a visitor on one chain: `/c/monad-testnet`.
 *
 * The active chain is a cookie, so this link sets it and the vault, the wallet
 * prompts and the explorer links are the ones the visitor came for. A chain
 * outside this deployment's set lands on the default, since the link is as
 * likely to be stale as mistyped.
 */
export async function GET(_request: Request, context: RouteContext<'/c/[chain]'>): Promise<never> {
  const { chain } = await context.params;

  try {
    await selectChain(chain);
  } catch (error) {
    if (!(error instanceof UnknownChain)) throw error;
    // A link to a network sets that network, whatever the visitor chose last.
    await clearChainChoice();
  }

  // Outside the try: redirect works by throwing.
  redirect('/');
}
