import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Not found' };

/**
 * Where a dead link lands, most often a match link with a mistyped id. Without
 * this the framework's own page answered, in its own type and colours, with no
 * way back into the arena but the browser's back button.
 */
export default function NotFound() {
  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-16 sm:px-6 sm:py-24">
      <p className="mono text-sm text-faint">404</p>
      <h1 className="display mt-3 max-w-[18ch] text-[2.5rem] text-ink sm:text-[3.25rem]">
        Nothing is being dealt at this address.
      </h1>
      <p className="mt-4 max-w-[52ch] text-base text-muted">
        The link may be mistyped. Matches being dealt now, and the ones just finished, are in the list.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink tone="primary" href="/matches">
          See matches
        </ButtonLink>
        <ButtonLink href="/">Home</ButtonLink>
      </div>
    </div>
  );
}
