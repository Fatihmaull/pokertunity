import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE,
  MAX_FRAMES_PER_SECOND,
  MAX_FRAME_BYTES,
  MAX_REASONING_BYTES,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  parseClientFrame,
  type ActFrame,
  type CloseCode,
  type DecisionFrame,
  type ServerFrame,
} from '@pokertunity/protocol';
import { SEAT_COST } from '../lib/economy';
import { MAX_AGENTS_PER_ACCOUNT, agentByToken, markClosed, markSeen } from './credentials';
import { QUEUE_OFF_REASON, attach, connectionsFor, detach, linkFor, type AgentLink } from './presence';
import { balanceOf } from './store';

/**
 * The agent socket.
 *
 * Agents dial in, and the arena listens. That is a security decision: the
 * arena makes zero requests on behalf of strangers, so the server-side request
 * forgery surface is simply absent. It also means a laptop behind a router can
 * play as well as a server.
 *
 * The second thing it buys is presence. A match holds every seat until it ends,
 * so the arena seats agents that are actually there, and being there is the
 * same fact as having a socket open.
 */

/** How long the handshake may take before the connection is dropped. */
const HANDSHAKE_MS = 10_000;

/**
 * Sockets one account may hold at once: one for every agent it can register.
 *
 * That lets a team run every strategy it registered at once, which is what
 * per-owner agents exist for. A connection for an agent that is already
 * connected replaces the old one, so this is a backstop a well-behaved owner
 * stays well inside.
 */
const MAX_CONNECTIONS_PER_ACCOUNT = MAX_AGENTS_PER_ACCOUNT;

/** How often the arena pings a quiet socket, to survive idle proxy timeouts. */
const HEARTBEAT_MS = 25_000;

const globalForSocket = globalThis as unknown as { __pokertunityWss?: WebSocketServer };

/**
 * Routes upgrade requests: `/agent` to the socket layer, everything else to
 * Next.
 *
 * Next runs its own WebSocket for hot reload in development on the same port,
 * so passing its upgrades through keeps the dev server working.
 */
export function attachAgentSocket(server: HttpServer, nextUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
  const wss = globalForSocket.__pokertunityWss ?? new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  globalForSocket.__pokertunityWss = wss;

  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== SOCKET_PATH) {
      nextUpgrade(request, socket, head);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      void greet(ws);
    });
  });
}

/**
 * Waits for the handshake, then either seats the connection on the floor or
 * says why it was refused and hangs up.
 *
 * Every refusal carries a code and a sentence. An agent author debugging at two
 * in the morning should be told what they did.
 */
export async function greet(
  ws: WebSocket,
  // The token lookup, as a parameter so the handshake can be driven in a test
  // from memory. The socket server always takes the default.
  lookup: typeof agentByToken = agentByToken,
): Promise<void> {
  const opened = Date.now();

  /**
   * Frames that arrive while the token is being looked up.
   *
   * Authenticating takes a database round trip, and a client that pipelines its
   * first frames sends them during it. This holds them, so an agent that sends
   * hello and ready together is welcomed and queued, in that order.
   */
  const backlog: string[] = [];
  const collect = (data: unknown) => backlog.push(String(data));

  const hello = await new Promise<{ version: number; token: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), HANDSHAKE_MS);

    ws.once('message', (data) => {
      clearTimeout(timer);
      ws.on('message', collect);
      const frame = parseClientFrame(data.toString());
      resolve(frame?.type === 'hello' ? { version: frame.version, token: frame.token } : null);
    });

    ws.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });


  if (!hello) {
    reject(ws, CLOSE.BAD_HANDSHAKE, 'Send a hello frame with a version and a token first.');
    return;
  }

  if (hello.version !== PROTOCOL_VERSION) {
    reject(
      ws,
      CLOSE.VERSION,
      `This arena speaks protocol ${PROTOCOL_VERSION} and you asked for ${hello.version}.`,
    );
    return;
  }

  const agent = await lookup(hello.token).catch(() => null);

  // The lookup is a round trip, and a client can hang up during it. Its close
  // has already fired by now, so this check is what keeps a departed agent off
  // the floor, out of the queue, and out of a seat it would time out in.
  if (ws.readyState !== ws.OPEN) return;

  if (!agent) {
    reject(ws, CLOSE.UNAUTHORIZED, 'That token matches zero agents. Rotate it on your account page.');
    return;
  }

  if (connectionsFor(agent.userId, agent.agentId) >= MAX_CONNECTIONS_PER_ACCOUNT) {
    reject(
      ws,
      CLOSE.FLOODING,
      `This account already has ${MAX_CONNECTIONS_PER_ACCOUNT} agents connected, the most it can run at once.`,
    );
    return;
  }

  // Detached here, immediately before the link attaches its own handler, so
  // a listener is attached through the whole token lookup and every frame in
  // that gap is kept.
  ws.off('message', collect);
  const link = new SocketLink(ws, agent.agentId, agent.userId, agent.queueEnabled);

  // The newer connection wins. An older one is nearly always a socket the far
  // end has already forgotten, and an agent that really did open two gets
  // straight back to playing.
  const replaced = attach(link);
  replaced?.close(CLOSE.REPLACED, 'This agent connected again from somewhere else.');

  await markSeen(agent.agentId).catch(() => {});

  link.send({
    type: 'welcome',
    version: PROTOCOL_VERSION,
    agentId: agent.agentId,
    name: agent.name,
    chips: await balanceOf(agent.userId).catch(() => 0),
    seatCost: SEAT_COST,
  });

  link.replay(backlog);

  console.log(`[socket] ${agent.name} connected in ${Date.now() - opened}ms`);
}

/**
 * Says why, then hangs up.
 *
 * The close waits for the error frame to actually go out. Calling both in the
 * same tick races on a socket that has just finished its upgrade, and waiting
 * is what delivers the explanation: the client sees the code and the reason.
 */
function reject(ws: WebSocket, code: CloseCode, message: string): void {
  const goodbye = () => ws.close(code, message.slice(0, 120));

  try {
    ws.send(JSON.stringify({ type: 'error', code, message } satisfies ServerFrame), () => goodbye());
  } catch {
    // The socket is already gone, which is the same outcome we were arranging.
    goodbye();
  }
}

/** What the dealer is waiting for while a seat thinks. */
interface Pending {
  id: string;
  onReasoning: (text: string) => void;
  settle: (decision: DecisionFrame | null) => void;
  reasoningBytes: number;
}

export class SocketLink implements AgentLink {
  ready = false;
  readySince: number | null = null;

  private pending: Pending | null = null;
  private framesThisSecond = 0;
  private secondStartedAt = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;
  /** Whether the far end answered the last ping. */
  private answered = true;
  /** The last queue status this connection was sent: null for queued, undefined before any. */
  private told: string | null | undefined = undefined;

  constructor(
    private readonly ws: WebSocket,
    readonly agentId: string,
    readonly ownerId: string,
    /** Its owner's switch as it stood at the handshake. See `setQueueOpen`. */
    private queueOpen = true,
  ) {
    ws.on('message', (data) => this.receive(data.toString()));
    ws.on('close', (code, reason) => this.ended(code, reason.toString()));
    ws.on('error', () => this.ended(CLOSE.MALFORMED, 'The connection errored.'));
    ws.on('pong', () => {
      this.answered = true;
    });

    // Unreferenced, so the server decides when the process exits, and a
    // keepalive timer stays a keepalive timer.
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS).unref();
  }

  /**
   * Pings, and hangs up on a connection that left the last ping unanswered.
   *
   * A network can lose a connection silently, on both ends. A socket like
   * that stays open here, and ready, until the operating system gives up on it,
   * which can take hours: long enough to be seated and to time out every
   * decision of a match its owner paid for. Public so the socket suite can
   * drive it directly, off the clock.
   */
  beat(): void {
    if (this.ws.readyState !== this.ws.OPEN) return;

    if (!this.answered) {
      this.ended(1006, 'Stopped answering pings.');
      this.ws.terminate();
      return;
    }

    this.answered = false;
    this.ws.ping();
  }

  requeue(now: number): void {
    if (this.ready) this.readySince = now;
  }

  setQueueOpen(open: boolean): void {
    this.queueOpen = open;
  }

  tellQueue(reason: string | null): void {
    if (this.told === reason) return;
    this.told = reason;
    this.send(reason === null ? { type: 'queued', queued: true, reason: null } : { type: 'queued', queued: false, reason });
  }

  /**
   * Handles frames that arrived during the handshake, in the order they came.
   *
   * Called after the welcome is on the wire, so a client that pipelined its
   * first frames still sees the handshake acknowledged before anything that
   * answers what it sent.
   */
  replay(backlog: readonly string[]): void {
    for (const raw of backlog) this.receive(raw);
  }

  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // A send that fails is a socket that is going away, and the close handler
      // is already on its way to clean up after it.
    }
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason.slice(0, 120));
  }

  ask(frame: ActFrame, onReasoning: (text: string) => void, signal: AbortSignal): Promise<DecisionFrame | null> {
    // Anything still outstanding belongs to a hand that has moved on. Settling
    // it as null is what keeps a slow agent from leaking a promise per decision
    // for the life of the connection.
    this.pending?.settle(null);

    if (this.ws.readyState !== this.ws.OPEN) return Promise.resolve(null);

    return new Promise<DecisionFrame | null>((resolve) => {
      let done = false;
      const settle = (decision: DecisionFrame | null) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        if (this.pending?.id === frame.id) this.pending = null;
        resolve(decision);
      };
      const abort = () => settle(null);

      this.pending = { id: frame.id, onReasoning, settle, reasoningBytes: 0 };
      signal.addEventListener('abort', abort, { once: true });
      this.send(frame);
    });
  }

  private receive(raw: string): void {
    if (this.flooding(raw)) return;

    const frame = parseClientFrame(raw);
    if (!frame) {
      this.fail(CLOSE.MALFORMED, 'That frame is outside what this arena understands.');
      return;
    }

    switch (frame.type) {
      case 'hello':
        // Already handshaken. A second hello is a confused client, and ignoring
        // it is free.
        return;

      case 'ping':
        return;

      case 'ready':
        // Stamped once. An agent that says ready twice keeps its place in the
        // queue, and the clock it has been waiting on keeps running.
        this.readySince ??= Date.now();
        this.ready = true;
        // Its owner's switch is the second gate, so an agent hears it is queued
        // exactly when it is.
        this.tellQueue(this.queueOpen ? null : QUEUE_OFF_REASON);
        return;

      case 'stop':
        this.ready = false;
        this.readySince = null;
        // Every seat plays its match to the end, so this applies to the next one.
        this.tellQueue('You asked to stop.');
        return;

      case 'reasoning': {
        const pending = this.pending;
        // A reasoning frame for a hand that has moved on is dropped, so this
        // hand's panel shows this hand's thinking.
        if (!pending || pending.id !== frame.id) return;

        pending.reasoningBytes += Buffer.byteLength(frame.text);
        if (pending.reasoningBytes > MAX_REASONING_BYTES) {
          this.fail(CLOSE.FLOODING, `Reasoning is capped at ${MAX_REASONING_BYTES} bytes per decision.`);
          return;
        }

        pending.onReasoning(frame.text);
        return;
      }

      case 'decision': {
        const pending = this.pending;
        // The correlation id is what keeps a late answer to hand four out of hand
        // five, an ordinary event once an act clock is involved.
        if (!pending || pending.id !== frame.id) return;
        pending.settle(frame);
        return;
      }
    }
  }

  /** True when the connection has been closed for abusing its allowance. */
  private flooding(raw: string): boolean {
    const now = Date.now();
    if (now - this.secondStartedAt >= 1000) {
      this.secondStartedAt = now;
      this.framesThisSecond = 0;
    }

    this.framesThisSecond += 1;
    if (this.framesThisSecond > MAX_FRAMES_PER_SECOND) {
      this.fail(CLOSE.FLOODING, `Frames are capped at ${MAX_FRAMES_PER_SECOND} a second.`);
      return true;
    }

    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      this.fail(CLOSE.FLOODING, `Frames are capped at ${MAX_FRAME_BYTES} bytes.`);
      return true;
    }

    return false;
  }

  private fail(code: CloseCode, message: string): void {
    this.send({ type: 'error', code, message });
    this.close(code, message);
  }

  private ended(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;

    // Asked before detaching, because detaching changes the answer. A
    // connection that was already replaced leaves the newer one's status alone,
    // so an owner reads "connected" about an agent sitting at a table right now.
    const wasCurrent = linkFor(this.agentId) === this;

    clearInterval(this.heartbeat);
    this.ready = false;
    this.readySince = null;

    // A hand waiting on this seat gets null, which the dealer already handles:
    // it checks if checking is free and folds when it costs chips.
    this.pending?.settle(null);
    this.pending = null;

    detach(this);

    if (wasCurrent) {
      void markClosed(this.agentId, reason || `Connection closed (${code}).`).catch(() => {});
    }
  }
}
