import { after, test } from 'node:test';
import assert from 'node:assert/strict';
// Must come before anything that reaches the database module. Every test here
// runs in memory, and that module needs a connection string to load.
import '../dev/test-env';
import type { WebSocket } from 'ws';
import {
  CLOSE,
  MAX_FRAMES_PER_SECOND,
  MAX_REASONING_BYTES,
  PROTOCOL_VERSION,
  type ActFrame,
} from '@pokertunity/protocol';
import { QUEUE_OFF_REASON, attach, connectionsFor, detach, linkFor } from './presence';
import { SocketLink, greet } from './socket';

/**
 * A socket that records what it would transmit.
 *
 * The paths worth testing here are the ones a well-behaved agent avoids: a reply
 * to a hand that has moved on, a flood, an agent that streams forever. A
 * scripted socket produces them on demand, and all of them are what will
 * actually happen once the arena is public.
 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  private handlers = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, handler: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, handler: (...args: never[]) => void): this {
    const wrapped = (...args: never[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
    );
    return this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closedWith ??= { code, reason };
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  pings = 0;
  ping(): void {
    this.pings += 1;
  }

  terminated = false;
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from(''));
  }

  emit(event: string, ...args: unknown[]): void {
    // A copy, because a `once` handler takes itself off the list mid-loop.
    for (const handler of [...(this.handlers.get(event) ?? [])]) (handler as (...a: unknown[]) => void)(...args);
  }

  /** What an agent would put on the wire. */
  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function linked(): { ws: FakeSocket; link: SocketLink } {
  const ws = new FakeSocket();
  const link = new SocketLink(ws as unknown as WebSocket, 'agent-1', 'owner-1');
  // The registry is global, so a test that attaches has to leave it as it found
  // it, so each test starts with a clean registry.
  after(() => detach(link));
  return { ws, link };
}

const ACT: ActFrame = {
  type: 'act',
  id: 'match:1:0:4',
  matchId: 'match',
  handNumber: 1,
  street: 'flop',
  seat: 0,
  button: 1,
  position: 'button',
  hole: ['As', 'Kd'],
  board: ['2c', '7h', 'Ts'],
  stack: 1800,
  committed: 0,
  potSize: 120,
  legal: { fold: true, check: false, call: 60, bet: null, raise: { min: 180, max: 1800 }, toCall: 60, potSize: 120 },
  equity: { equity: 0.42, win: 420, tie: 0, lose: 580, samples: 1000 },
  read: { made: 'ace high', flushDraw: false, openEnded: false, gutshot: false, overcards: true },
  opponents: [],
  remainingMs: 30_000,
};

test('connecting and asking for a game are separate steps', () => {
  const { ws, link } = linked();

  assert.equal(link.ready, false, 'an agent debugging against a live arena stays unseated');

  ws.receive({ type: 'ready' });
  assert.equal(link.ready, true);

  ws.receive({ type: 'stop' });
  assert.equal(link.ready, false);
});

test('asking for a game is refused while its owner has matches switched off', () => {
  const ws = new FakeSocket();
  const link = new SocketLink(ws as unknown as WebSocket, 'agent-off', 'owner-off', false);

  ws.receive({ type: 'ready' });
  assert.equal(link.ready, true, 'it has still asked, which is what the queue reads once the switch is on');
  const [told] = ws.frames().filter((frame) => frame.type === 'queued');
  assert.equal(told.queued, false, 'the agent hears it is waiting, and why');
  assert.equal(told.reason, QUEUE_OFF_REASON);

  // The matchmaker reads the switch on its next tick and says so once.
  link.setQueueOpen(true);
  link.tellQueue(null);
  assert.deepEqual(
    ws.frames().filter((frame) => frame.type === 'queued').map((frame) => frame.queued),
    [false, true],
  );
});

test('the queue status is sent when it changes', () => {
  const { ws, link } = linked();

  ws.receive({ type: 'ready' });
  ws.receive({ type: 'ready' });
  link.tellQueue(null);
  link.tellQueue('A seat costs 2,040 chips and this account holds 1,000. Buy chips at the cashier.');
  link.tellQueue('A seat costs 2,040 chips and this account holds 1,000. Buy chips at the cashier.');
  ws.receive({ type: 'stop' });

  assert.deepEqual(
    ws.frames().filter((frame) => frame.type === 'queued').map((frame) => frame.queued),
    [true, false, false],
    'queued once, refused once for chips, stopped once',
  );
});

test('how long an agent has waited is measured from when it asked', () => {
  // The matchmaker widens its rating band by this, so it means exactly
  // waiting. An agent returning after a day away starts with a narrow band.
  const { ws, link } = linked();

  assert.equal(link.readySince, null, 'a connection that is yet to ask is idle');

  ws.receive({ type: 'ready' });
  const asked = link.readySince;
  assert.ok(asked !== null);

  ws.receive({ type: 'ready' });
  assert.equal(link.readySince, asked, 'saying it twice keeps its place in the queue');

  ws.receive({ type: 'stop' });
  assert.equal(link.readySince, null);
});

test('a decision for the hand in flight is the one that counts', async () => {
  const { ws, link } = linked();

  const answer = link.ask(ACT, () => {}, new AbortController().signal);
  ws.receive({ type: 'decision', id: ACT.id, action: 'call' });

  assert.deepEqual(await answer, { type: 'decision', id: ACT.id, action: 'call' });
});

test('a decision carrying the wrong id is ignored', async () => {
  // The case this exists for: an agent times out on hand four, the arena moves
  // on, and its answer lands during hand five. The correlation check keeps a
  // legal-looking move from a finished position out of the live hand.
  const { ws, link } = linked();
  const clock = new AbortController();

  const answer = link.ask(ACT, () => {}, clock.signal);
  ws.receive({ type: 'decision', id: 'some:other:hand', action: 'raise', to: 1800 });

  clock.abort();
  assert.equal(await answer, null, 'the stale answer is ignored');
});

test('reasoning reaches the panel while its own hand is live', async () => {
  const { ws, link } = linked();
  const seen: string[] = [];
  const clock = new AbortController();

  const answer = link.ask(ACT, (text) => seen.push(text), clock.signal);
  ws.receive({ type: 'reasoning', id: ACT.id, text: 'Pot odds are fine. ' });
  ws.receive({ type: 'reasoning', id: 'stale', text: 'Last hand’s thinking.' });
  ws.receive({ type: 'decision', id: ACT.id, action: 'call' });

  await answer;
  assert.deepEqual(seen, ['Pot odds are fine. ']);
  clock.abort();
});

test('an agent that streams forever loses its connection, and the arena plays on', async () => {
  const { ws, link } = linked();
  const clock = new AbortController();

  const answer = link.ask(ACT, () => {}, clock.signal);
  for (let i = 0; i < 20; i++) {
    ws.receive({ type: 'reasoning', id: ACT.id, text: 'x'.repeat(512) });
  }

  assert.equal(ws.closedWith?.code, CLOSE.FLOODING);
  assert.match(ws.closedWith!.reason, new RegExp(String(MAX_REASONING_BYTES)));
  assert.equal(await answer, null, 'the hand settles as null and moves on');
});

test('a frame flood is closed with a stated reason', () => {
  const { ws } = linked();

  for (let i = 0; i < MAX_FRAMES_PER_SECOND + 5; i++) ws.receive({ type: 'ping' });

  assert.equal(ws.closedWith?.code, CLOSE.FLOODING);
  // An agent author at two in the morning deserves to be told what they did.
  assert.match(ws.closedWith!.reason, /a second/);
});

test('a malformed frame closes the connection', () => {
  const { ws } = linked();

  ws.emit('message', Buffer.from('not json at all'));

  assert.equal(ws.closedWith?.code, CLOSE.MALFORMED);
});

test('a socket that vanishes mid-hand settles the hand', async () => {
  const { ws, link } = linked();

  const answer = link.ask(ACT, () => {}, new AbortController().signal);
  ws.close(1006, 'connection lost');

  assert.equal(await answer, null);
  assert.equal(link.ready, false, 'and it stops being queued for the next match');
});

test('asking again abandons whatever the last question was waiting for', async () => {
  const { link } = linked();
  const clock = new AbortController();

  const first = link.ask(ACT, () => {}, clock.signal);
  const second = link.ask({ ...ACT, id: 'match:1:0:9' }, () => {}, clock.signal);

  assert.equal(await first, null, 'or a slow agent leaks one promise per decision, forever');
  clock.abort();
  assert.equal(await second, null);
});

test('frames that arrived during the handshake are kept', () => {
// A client that pipelines hello and ready sends both before the welcome, and
// authenticating is a database round trip. Holding what arrives in that
// window gets such an agent welcomed and queued, in order.
  const { link } = linked();

  assert.equal(link.ready, false);
  link.replay([JSON.stringify({ type: 'ready' })]);
  assert.equal(link.ready, true);
});

test('a replaced connection leaves the live one’s status alone', () => {
  const first = linked();
  const second = linked();

  attach(first.link);
  attach(second.link);

  // The older socket closes after the newer one has taken its place. The
  // owner keeps reading "connected" about an agent sitting at a table right
  // now.
  first.ws.close(CLOSE.REPLACED, 'connected again from somewhere else');

  assert.equal(linkFor('agent-1'), second.link, 'the newer connection survives');

  second.ws.close(1001, 'going away');
  assert.equal(linkFor('agent-1'), undefined);
});

test('an agent reconnecting is left out of its own account’s count', () => {
// The cap counts the sockets an account holds. An agent whose last socket is
// still on record is replacing that socket, so it gets back in at the moment
// it needs to.
  const ws = new FakeSocket();
  const link = new SocketLink(ws as unknown as WebSocket, 'agent-cap', 'owner-cap');
  attach(link);
  after(() => detach(link));

  assert.equal(connectionsFor('owner-cap'), 1);
  assert.equal(connectionsFor('owner-cap', 'agent-cap'), 0, 'its own older socket is about to be replaced');
  assert.equal(connectionsFor('owner-cap', 'agent-other'), 1, 'a different agent is one more connection');
});

test('a client that hangs up while its token is looked up stays off the floor', async () => {
  // The lookup is a database round trip. A client gone before it answers has
  // already fired its close, so a link built on the socket afterwards would sit
  // in presence for good: connected, queued off its pipelined ready, and seated
  // to time out every decision of a match its owner was charged for.
  const ws = new FakeSocket();
  const greeted = greet(ws as unknown as WebSocket, async () => {
    ws.close(1006, 'connection lost');
    return { agentId: 'agent-ghost', userId: 'owner-ghost', name: 'Ghost', color: 'red', queueEnabled: true };
  });

  ws.receive({ type: 'hello', version: PROTOCOL_VERSION, token: 'ah_test' });
  ws.receive({ type: 'ready' });
  await greeted;

  assert.equal(linkFor('agent-ghost'), undefined, 'a closed socket gets zero links');
  assert.equal(connectionsFor('owner-ghost'), 0, 'and its owner’s count stays at zero');
});

test('a connection that stops answering pings is hung up on and taken off the floor', () => {
  const { ws, link } = linked();
  attach(link);
  ws.receive({ type: 'ready' });

  link.beat();
  assert.equal(ws.pings, 1, 'a quiet connection is pinged');

  ws.emit('pong');
  link.beat();
  assert.equal(ws.pings, 2);
  assert.equal(ws.terminated, false, 'one that answered stays');

  link.beat();
  assert.equal(ws.terminated, true, 'one that left the last ping unanswered is ended');
  assert.equal(linkFor('agent-1'), undefined);
  assert.equal(link.ready, false, 'and leaves the queue');
});

test('a match that ends starts the wait again, for an agent still asking', () => {
  const { ws, link } = linked();
  ws.receive({ type: 'ready' });
  const asked = link.readySince!;
  const matchEnded = asked + 80 * 60_000;

  link.requeue(matchEnded);
  assert.equal(link.readySince, matchEnded, 'eighty minutes at a table count as table time');

  ws.receive({ type: 'stop' });
  link.requeue(matchEnded + 60_000);
  assert.equal(link.readySince, null, 'an agent that asked to stop stays out of the queue');
});
