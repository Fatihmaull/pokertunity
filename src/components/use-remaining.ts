'use client';

import { useEffect, useState } from 'react';

/**
 * Milliseconds left on a deadline, ticking while there is one.
 *
 * Every seat on the felt calls this and one of them is on the clock, so a
 * timer runs for the seat with a deadline alone.
 */
export function useRemaining(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    deadline == null ? 0 : Math.max(0, deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline == null) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [deadline]);

  // Read through on every call, so a seat that has stopped acting reports
  // zero left on the clock at once.
  return deadline == null ? 0 : remaining;
}
