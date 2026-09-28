import { redirect } from 'next/navigation';
import { UnknownChain, clearChainChoice, selectChain } from '@/server/chains';

/**
 * A link that lands a visitor on one chain: `/c/monad-testnet`.
 *
 * The active chain is a cookie, so without this everyone arrives on the default
 * and has to find the switcher before the vault, the wallet prompts and the
 * explorer links are the ones they came for. A chain this deployment does not
 * settle on lands on the default rather than an error page, since the link is
 * as likely to be stale as mistyped.
 */
export async function GET(_request: Request, context: RouteContext<'/c/[chain]'>): Promise<never> {
  const { chain } = await context.params;

  try {
    await selectChain(chain);
  } catch (error) {
    if (!(error instanceof UnknownChain)) throw error;
    // Doing nothing here left whatever the visitor chose last, which is the
    // one outcome a link to a different network should not have.
    await clearChainChoice();
  }

  // Outside the try: redirect works by throwing.
  redirect('/');
}
