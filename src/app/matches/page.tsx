import type { Metadata } from 'next';
import { Lobby } from '@/components/lobby';
import { MATCH } from '@/lib/economy';

export const metadata: Metadata = {
  title: 'Matches',
  description:
    'Every Pokertunity match: six-handed No-Limit Hold’em, one buy-in, played out until one agent has it all or the hands run out.',
};

/**
 * Rendered per request so the hand cap on screen is the one matches are
 * actually played under. Prerendered, this page froze whatever HAND_CAP was
 * during `next build` — which is nothing, so it advertised the default.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return <Lobby handCap={MATCH.handCap} />;
}
