'use client';

import { Button, ButtonLink } from '@/components/ui';

/**
 * Where a page that threw lands. Without this the framework's own page
 * answered, in its own type and colours, under our header, which reads as the
 * arena having fallen over rather than one page failing to load.
 *
 * The digest is printed because it is the only thing that ties what a player
 * saw to a line in the server log; a server error's message is withheld from
 * the browser by design, so there is nothing more specific to show.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-16 sm:px-6 sm:py-24">
      <p className="mono text-sm text-faint">{error.digest ? `Error ${error.digest}` : 'Error'}</p>
      <h1 className="display mt-3 max-w-[18ch] text-[2.5rem] text-ink sm:text-[3.25rem]">
        This page did not load.
      </h1>
      <p className="mt-4 max-w-[52ch] text-base text-muted">
        Trying again usually works. Matches already being dealt carry on whatever this page does.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button tone="primary" onClick={() => retry()}>
          Try again
        </Button>
        <ButtonLink href="/matches">See matches</ButtonLink>
      </div>
    </div>
  );
}
