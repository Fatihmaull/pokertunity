import { PROTOCOL_VERSION } from '@pokertunity/protocol';

/**
 * Complete agents to paste and run, one per language, for the connect guide.
 *
 * They depend on nothing from this repository. `@pokertunity/protocol` is not
 * published, so an example that imports it runs inside a checkout and nowhere
 * else, and the person reading the guide has no checkout. Each one is the whole
 * wire, hello to decision, around a `decide` that is meant to be thrown away:
 * it plays off the arena's own equity figure so that it is a legal, sensible
 * entrant on the first run, and replacing it is the only edit anyone has to
 * make. The token comes from the command line rather than an environment
 * variable because `VAR=value command` is one syntax in bash and another in
 * PowerShell, and an argument is the same in both.
 */

export type StarterLanguage = 'javascript' | 'python';

export interface Starter {
  id: StarterLanguage;
  label: string;
  file: string;
  /** What to install first, or null when the runtime has it built in. */
  install: string | null;
  run: string;
  code: (url: string) => string;
}

export const STARTERS: readonly Starter[] = [
  {
    id: 'javascript',
    label: 'JavaScript',
    file: 'agent.mjs',
    install: null,
    run: 'node agent.mjs ah_your_token',
    code: (url) => `// agent.mjs. Node 22 or later has WebSocket built in, so nothing to install.
const ARENA = '${url}';
const TOKEN = process.argv[2];

// Your strategy. Return one of the moves act.legal allows. It may be async,
// so this is where a model call would go.
async function decide(act) {
  const { legal, potSize } = act;
  const equity = act.equity.equity; // the arena's estimate of your share of the pot
  const price = legal.toCall / (potSize + legal.toCall); // the equity a call needs
  if (equity > 0.66 && legal.raise) return { action: 'raise', to: legal.raise.min };
  if (equity > 0.66 && legal.bet) return { action: 'bet', to: legal.bet.min };
  if (legal.call !== null && equity > price) return { action: 'call' };
  if (legal.check) return { action: 'check' };
  return { action: 'fold' };
}

function connect() {
  const ws = new WebSocket(ARENA);
  const send = (frame) => ws.send(JSON.stringify(frame));
  ws.onopen = () => send({ type: 'hello', version: ${PROTOCOL_VERSION}, token: TOKEN });
  ws.onmessage = async ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'welcome' || frame.type === 'match-end') send({ type: 'ready' });
    if (frame.type === 'queued') console.log(frame.queued ? 'Queued' : 'Not queued: ' + frame.reason);
    if (frame.type === 'act') {
      let move = { action: frame.legal.check ? 'check' : 'fold' };
      try {
        move = await decide(frame);
      } catch (error) {
        console.error(error);
      }
      send({ type: 'decision', id: frame.id, ...move });
    }
  };
  ws.onclose = ({ code, reason }) => {
    console.log('Disconnected:', code, reason);
    // 4000 to 4005 mean something to fix first, and the reason says what.
    if (code < 4000 || code > 4005) setTimeout(connect, 5000);
  };
}

connect();
`,
  },
  {
    id: 'python',
    label: 'Python',
    file: 'agent.py',
    install: 'pip install websockets',
    run: 'python agent.py ah_your_token',
    code: (url) => `# agent.py. Python 3.11 or later, after: pip install websockets
import asyncio, json, sys
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

ARENA = "${url}"
TOKEN = sys.argv[1]

# Your strategy. Return one of the moves act["legal"] allows. It is async,
# so this is where a model call would go.
async def decide(act):
    legal = act["legal"]
    equity = act["equity"]["equity"]  # the arena's estimate of your share of the pot
    price = legal["toCall"] / (act["potSize"] + legal["toCall"])  # the equity a call needs
    if equity > 0.66 and legal["raise"]:
        return {"action": "raise", "to": legal["raise"]["min"]}
    if equity > 0.66 and legal["bet"]:
        return {"action": "bet", "to": legal["bet"]["min"]}
    if legal["call"] is not None and equity > price:
        return {"action": "call"}
    if legal["check"]:
        return {"action": "check"}
    return {"action": "fold"}

async def main():
    async for ws in connect(ARENA):  # reconnects by itself when the arena drops
        try:
            await ws.send(json.dumps({"type": "hello", "version": ${PROTOCOL_VERSION}, "token": TOKEN}))
            async for raw in ws:
                frame = json.loads(raw)
                if frame["type"] in ("welcome", "match-end"):
                    await ws.send(json.dumps({"type": "ready"}))
                elif frame["type"] == "queued":
                    print("Queued" if frame["queued"] else f"Not queued: {frame['reason']}")
                elif frame["type"] == "act":
                    try:
                        move = await decide(frame)
                    except Exception as error:
                        print(error)
                        move = {"action": "check" if frame["legal"]["check"] else "fold"}
                    await ws.send(json.dumps({"type": "decision", "id": frame["id"], **move}))
        except ConnectionClosed as closed:
            print("Disconnected:", closed)
            # 4000 to 4005 mean something to fix first, and the reason says what.
            if closed.rcvd and 4000 <= closed.rcvd.code <= 4005:
                return

asyncio.run(main())
`,
  },
];
