import type { ActFrame, DecisionFrame, ServerFrame } from '@pokertunity/protocol';

/**
 * Who is connected, and how the rest of the arena talks to them.
 *
 * Presence deliberately lives in process memory. A socket is a fact about this
 * process, and memory forgets it the moment a crash ends the connection, so
 * "connected" is always true when it is shown. The database knows what an agent
 * is; this knows whether it is here.
 *
 * Everything above this file talks to an `AgentLink`, so the socket layer is
 * the one importer of a WebSocket library. That is what lets the matchmaker,
 * the dealer and the account page all ask about presence while the wire stays
 * the socket layer's business.
 */

export interface AgentLink {
  readonly agentId: string;
  readonly ownerId: string;
  /** Whether it has asked to be queued. Asking is a `ready` frame, separate from connecting. */
  readonly ready: boolean;
  /**
   * When it asked, as epoch milliseconds, or null while it is idle.
   *
   * The matchmaker widens its rating band by how long somebody has waited, so
   * this means exactly "waiting since", stamped on the socket. An agent
   * returning after a day away starts with a narrow band like everybody else.
   */
  readonly readySince: number | null;
  /** Fire and forget. A closed socket swallows it quietly. */
  send(frame: ServerFrame): void;
  /**
   * Asks for a move and waits for one.
   *
   * Resolves null when the answer is unusable or late, which covers a
   * timeout, a reply carrying the wrong correlation id, a malformed frame and a
   * socket that vanished. The caller treats all four the same way, because from
   * the table's point of view they are the same thing: the seat was silent.
   */
  ask(
    frame: ActFrame,
    onReasoning: (text: string) => void,
    signal: AbortSignal,
  ): Promise<DecisionFrame | null>;
  /** Ends the connection with a code and a sentence the owner will read. */
  close(code: number, reason: string): void;
  /**
   * Starts its wait again from `now`, if it is still asking for a game.
   *
   * Called when its match ends. Time spent playing is separate from time spent
   * waiting, so an agent back from eighty minutes at a table starts with a
   * narrow band, which is exactly what `readySince` exists for.
   */
  requeue(now: number): void;
  /**
   * Whether its owner lets it be seated, as far as this connection last heard.
   *
   * The database is the authority and the matchmaker re-reads it every tick;
   * this copy lets the answer to `ready` be right the moment it is asked.
   */
  setQueueOpen(open: boolean): void;
  /**
   * Tells the agent whether it is queued, and why it is waiting when it is.
   *
   * Sent when the answer differs from the last one this connection was given,
   * so a status that holds for an hour is one frame. Null means queued.
   */
  tellQueue(reason: string | null): void;
}

/**
 * Why an agent that asked for a game is waiting: its owner has *Play matches*
 * off for it. Shared so the socket's own reply and the matchmaker's later ones
 * read the same and dedupe against each other.
 */
export const QUEUE_OFF_REASON =
  'This agent is waiting for its owner to turn on Play matches from the agents page.';

const globalForPresence = globalThis as unknown as {
  __pokertunityPresence?: Map<string, AgentLink>;
};

function registry(): Map<string, AgentLink> {
  if (!globalForPresence.__pokertunityPresence) globalForPresence.__pokertunityPresence = new Map();
  return globalForPresence.__pokertunityPresence;
}

/**
 * Puts a connection on the floor, replacing any earlier one for the same agent.
 *
 * The newer connection wins because the older one is almost always a socket the
 * far end has already forgotten about, and an agent that genuinely opened two
 * recovers at once.
 */
export function attach(link: AgentLink): AgentLink | undefined {
  const existing = registry().get(link.agentId);
  registry().set(link.agentId, link);
  return existing;
}

/** Removes a connection, when it is still the current one. */
export function detach(link: AgentLink): void {
  if (registry().get(link.agentId) === link) registry().delete(link.agentId);
}

export function linkFor(agentId: string): AgentLink | undefined {
  return registry().get(agentId);
}

export function presenceOf(agentId: string): { connected: boolean; ready: boolean } {
  const link = registry().get(agentId);
  return { connected: link !== undefined, ready: link?.ready ?? false };
}

/**
 * Every agent currently asking for a game, and since when.
 *
 * What the matchmaker draws from. The timestamp travels with the id because the
 * two are one fact: an agent is waiting, and it has been waiting this long.
 */
export function readyAgents(): Map<string, number> {
  const waiting = new Map<string, number>();
  for (const link of registry().values()) {
    if (link.ready) waiting.set(link.agentId, link.readySince ?? Date.now());
  }
  return waiting;
}

/**
 * Records an owner flipping the switch, on the connection if this process holds it.
 *
 * So that an agent saying `ready` straight afterwards is answered with the new
 * setting. The matchmaker re-reads the switch on its next tick and tells the
 * agent, which keeps queue messages to one source.
 */
export function noteQueueSwitch(agentId: string, open: boolean): void {
  registry().get(agentId)?.setQueueOpen(open);
}

/**
 * How many sockets one account is holding. Used to cap them at the handshake.
 *
 * The agent about to connect is left out of the count, because its own older
 * socket is about to be replaced. That lets an agent reconnect before the arena
 * notices its last connection drop, which is exactly when it most needs to get
 * back in.
 */
export function connectionsFor(ownerId: string, replacingAgentId?: string): number {
  let count = 0;
  for (const link of registry().values()) {
    if (link.ownerId === ownerId && link.agentId !== replacingAgentId) count += 1;
  }
  return count;
}

/** Hangs up on everyone with a reason, so a restart tells agents to come back. */
export function closeAll(code: number, reason: string): void {
  for (const link of [...registry().values()]) link.close(code, reason);
  registry().clear();
}
