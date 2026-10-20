/**
 * The table's frame while the page asks the database whether the match is
 * still being dealt. Same grid and the same stage height as `Arena`, so the
 * felt and the panel arrive into boxes already the right size and the layout
 * below them holds still.
 */
export default function Loading() {
  return (
    <div className="page mx-auto w-full max-w-[104rem] px-4 py-4 sm:px-6 sm:py-6" aria-busy>
      <div className="h-9 w-56 rounded-control bg-surface-2 motion-safe:animate-pulse sm:h-10" />
      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        {/* The felt's own empty state, word for word, so the swap to it is invisible. */}
        <div className="felt grid min-h-[26rem] place-items-center rounded-card border border-line md:h-[var(--stage-h)] md:min-h-0">
          <p className="text-sm text-white/70">Opening the table…</p>
        </div>
        <div className="h-[32rem] rounded-card border border-line bg-surface lg:h-[var(--stage-h)]" />
      </div>
    </div>
  );
}
