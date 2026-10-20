import type { ArenaEvent } from './view';

type Listener = (event: ArenaEvent) => void;

/**
 * One broadcast channel per table. Spectators subscribe over server-sent
 * events; the table publishes and moves on.
 *
 * The bus is unbuffered. A spectator arriving mid-hand is caught up by the
 * stream route rendering a fresh `runtime.view(viewer)` snapshot, which is what
 * keeps redaction per-viewer, with every snapshot rendered for its viewer.
 */
export class TableBus {
  private readonly listeners = new Set<Listener>();

  // Called as `runtime.bus.subscribe` from the SSE route, a path static
  // analysis skips through the field.
  // fallow-ignore-next-line unused-class-member
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ArenaEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A hand plays on past a broken subscriber.
      }
    }
  }
}
