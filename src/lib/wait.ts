/**
 * Waits, ending early when told to stop.
 *
 * The listener is taken off the signal whichever way the wait ends. A match
 * shares one signal across every beat of every hand, so a listener left behind
 * by each wait that simply ran out is thousands of dead closures by the end of a
 * match. A signal that has already fired ends the wait at once, because an
 * aborted signal fires exactly once.
 */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
