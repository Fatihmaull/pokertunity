import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui';

// Read by Next when it renders a 404, an export static analysis overlooks.
// fallow-ignore-next-line unused-export
export const metadata: Metadata = { title: '404' };

/**
 * Where a dead link lands, most often a match link with a mistyped id, in the
 * arena's own type and colours, with a way back in.
 */
export default function NotFound() {
  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-16 sm:px-6 sm:py-24">
      <p className="mono text-sm text-faint">404</p>
      <h1 className="display mt-3 max-w-[18ch] text-[2.5rem] text-ink sm:text-[3.25rem]">
        This address leads to an empty table.
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
