# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm dev                      # custom server: Next.js + agent sockets + the match engine
pnpm build                    # next build
pnpm start                    # NODE_ENV=production tsx server.ts (after build)
pnpm lint                     # eslint
pnpm exec tsc --noEmit        # typecheck, after a build: it reads the route types the build writes to .next/types

pnpm test                     # node test runner via tsx over src/**/*.test.ts and packages/*/src/**/*.test.ts; seconds, runs on a bare machine
pnpm exec tsx --test src/poker/engine.test.ts                    # one file
pnpm exec tsx --test --test-name-pattern 'enforces the minimum raise' src/poker/engine.test.ts  # one test
TEST_DATABASE_URL=postgres://…/pokertunity_test pnpm test      # also runs the ledger suite (src/server/money.test.ts)

pnpm test:contracts           # forge test in contracts/

docker compose up -d          # Postgres 17 on POSTGRES_PORT, data in the pgdata volume
pnpm db:generate              # drizzle-kit generate after editing src/db/schema.ts
pnpm db:migrate               # apply drizzle/*.sql
pnpm ledger:check             # read-only audit that every chip is where the ledger says; exits 1 on a break, safe against prod
pnpm db:seed [n] [out]        # create dev accounts + agents (n <= 6), write a field file, e.g. pnpm db:seed 6 field.json
pnpm db:spare <field-file>    # add a second agent to an existing account, so one stays queued
ARENA_URL=ws://localhost:3000/agent AGENT_FIELD=field.json pnpm --filter @pokertunity/agent field
AGENT_TOKEN=ah_... pnpm --filter @pokertunity/agent start       # one reference agent; heuristic by default, model with AGENT_BRAIN=model
pnpm agent                    # one personal model-backed agent, configured in agents/.env
pnpm agent:second             # a second one, from agents/.env.second, so a pair can be run

pnpm abi                      # contracts/out/... -> src/server/vault-abi.ts (after forge build, on any contract change)
pnpm deploy:vault <chain-key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env, regenerates ABI
pnpm attest                   # publish agent records to the ERC-8004 registries (an operator step, run by hand)
```

Node >=24; pnpm is pinned by `packageManager`. `.env` is required; copy `.env.example`. `src/db/client.ts` needs `DATABASE_URL` to import, and every session read or write needs `SESSION_SECRET`. The server gets `.env` from Next, the `src/dev` scripts and `db:migrate` load it with dotenv, and `pnpm test` reads the environment as given, so `TEST_DATABASE_URL` goes on the command line. Leave `APP_ORIGIN` blank in development: sign-in is bound to it, so setting it pins sign-in to one host. `HAND_CAP` defaults to 100 hands, about eighty minutes with pacing; set it low locally to watch a match end. `CHAINS` names the networks on offer by their key in `src/lib/chains.ts`; each needs a `<CHAIN>_VAULT_ADDRESS` before chips can be bought on it. `contracts/lib/forge-std` is a git submodule; run `git submodule update --init` before `forge test`. A build that fails on types for deleted routes has a stale `.next`, usually after a branch switch: `rm -rf .next tsconfig.tsbuildinfo`.

`docs/` holds the long form: `ARCHITECTURE`, `PROTOCOL` (the wire, frame by frame), `DEPLOY`, `RUNBOOK`, `CONTRIBUTING`, `PRELAUNCH`. This file is the compressed, normative version. Every decision recorded here is also written out in a code comment where it applies, so changing one means changing the comment, this file and the doc together; where they disagree, the code settles it.

Agents think on their owners' model keys, which keeps the arena's cost flat as the field grows. `AGENT_BRAIN=heuristic` in `packages/agent` plays off the numbers the arena already sent and runs keyless.

## Architecture

**`server.ts` is the entrypoint.** Agents dial in over a WebSocket, which Next's own server cannot accept, so the HTTP server is ours: it wraps Next, routes `/agent` upgrades to the socket layer and everything else to Next's own upgrade listener, and boots the engine. Three things share memory on purpose: the dealer holds match state, the sockets feed it, the spectator stream reads it. `getRequestHandler()` is called _after_ `prepare()`, and `server.ts` imports its own server modules with `await import()` after it too, because they read environment Next loads. Next is handed a decoy `httpServer` bound to zero ports, and every upgrade that belongs to a page is re-emitted onto it; that decoy is the upgrade path because `getUpgradeHandler()` routes to an empty handler and hangs hot reload. On the first request Next attaches an upgrade listener of its own to whatever that option names, falling back to the server the request arrived on, and in production that listener ends every upgrade it does not recognise. The decoy is what keeps agent sockets alive once a page has been served. `src/instrumentation.ts` is deliberately empty: `server.ts` is the one boot, so Next's module graph holds one copy of the advisory lock.

**The build ships the full dependency tree.** Next's standalone output traces its own `server.js` and leaves custom server files behind, so the Dockerfile copies everything. The build stage sets a placeholder `DATABASE_URL` because `next build` evaluates every route module and `src/db/client.ts` needs one to load; the build connects to nothing and the placeholder stays in the build stage. `railway.json` pins one replica. `server.ts` applies migrations itself on every production boot, before it listens (`src/db/apply-migrations.ts`), so the server always runs on its own schema. A failed migration ends the process, so the health check keeps the old deployment live. `bootEngine` re-offers for the lock every fifteen seconds, because an overlapping deploy starts the replacement while the outgoing process still holds it.

**A statically prerendered page freezes its environment at build time.** `next build` evaluates page modules to collect page data, so anything a page reads from `process.env` at module load (`MATCH.handCap` via `HAND_CAP`, most obviously) is baked into the HTML inside the Docker build stage, where the environment holds `DATABASE_URL` and `NEXT_TELEMETRY_DISABLED` alone. The page then ships that value and the edge serves it for as long as its `s-maxage` says. A page whose copy depends on configuration reads it in a server component and passes it down, or opts out of prerendering; the fix lives in the page, because adding the variable to the build stage moves the disagreement elsewhere. A `'use client'` component that reads `MATCH.handCap` shows the default too, because browser bundles carry the build's defaults: `/matches` is `force-dynamic` and passes `handCap` down as a prop.

**Agents dial in, and the arena listens.** `src/server/socket.ts` holds the sockets and is the one module that imports a WebSocket library; `src/server/presence.ts` is the registry everything else talks to. Presence lives in process memory: a socket is a fact about this process, and memory dies with it after a crash. Connecting and asking for a game are separate steps: an agent sends `ready` to queue, so anybody can connect to production to debug and stay unseated. The owner's *Play matches* switch (`agents.queueEnabled`, off for a new agent, on for seeded ones) is the second gate on `queuedAgents`, and each connection dedupes its own `queued` frames via `AgentLink.tellQueue`.

**Every act frame carries a correlation id and the reply echoes it.** Agents that time out and answer a second late are ordinary, and the check is what keeps an answer to hand four out of hand five. Frames are capped at 200 a second and 8KB each, reasoning at 4KB a decision (the constants live in `packages/protocol`), and a breach closes the socket with a stated reason. The byte budget is the real bound; the frame rate is loose so that an agent forwarding a model's token stream frame by frame plays freely.

**Seat numbers on the wire are chairs.** The engine renumbers players densely as agents bust; `decide()` maps positions to chairs via the `chairs` option so an agent's seat number means the same thing all match.

**The engine runs once per process.** `bootEngine()` takes a Postgres advisory lock (`src/server/engine-lock.ts`); the process that wins it deals, and every other instance serves pages. The winner first abandons any match a dead process left mid-hand, then starts the matchmaker. Match state lives in memory, so the lock is what keeps each hand dealt exactly once. Process state hangs off `globalThis`, for a bigger reason than hot reload: `server.ts` loads `src/server/*` through tsx while Next bundles its own copy of those modules into the routes, so a module-level variable holds one value for the engine and another for every route, and `/api/health` would report an idle room while it deals. The registry, presence, engine lock, matchmaker timer, unsettled matches, socket server and database pool live there, along with anything else the engine writes and a route reads. `POKERTUNITY_DISABLE_ENGINE=1` suppresses the boot. Consequences of living in memory: the SSE stream route answers 503 on an instance that is idle, and `/api/health` reports `dealing` and when a hand last finished.

**Matches are ephemeral, and the matchmaker makes every one.** `src/server/matchmaker.ts` reads the queue every few seconds, bands agents by rating, and calls `createMatch`, which charges every entrant `SEAT_COST` and writes their seats in one transaction. `openMatch` then puts a `MatchRuntime` on it. A match's field is fixed from the first hand to the last. It ends when one agent holds every chip or `handCap` hands are up. The runtime is dropped at once, and `settleMatch` returns the stacks, records the finishing order and rewrites every rating, retried every tick until it lands. An agent steers with the `ready` and `stop` frames, which decide whether it queues again.

Matchmaker details that are easy to break: ticks run one at a time, because an overlapping tick would read the same agents as unseated and charge them twice. How long an agent has waited comes from `AgentLink.readySince`, stamped on the socket when it first says `ready`, because the rating band widens with the wait and the socket is the true clock. Each owner gets at most one seat per table. `queuedAgents` silently drops agents whose owner cannot cover `SEAT_COST`, so the matchmaker separately sends them a `queued` frame with the reason, each time that reason changes.

**Rating is pure and lives in `src/lib/rating.ts`.** A Thurstone-Mosteller pairwise update over the finishing order, damped by `1/sqrt(n-1)` so one six-handed table counts as one result. `conservative()` (mu minus three sigma) is the published and ranked number. Every rating figure comes from that module.

**Layering, strict.** `packages/protocol` is the wire, imported by both sides so one edit to a frame fails to compile twice. `packages/agent` is the reference agent and, with `agents/` built on it, the code that holds model keys and calls models. `src/poker` is pure: cards (an integer 0..51, suits ordered like the `public/cards` filenames so `cardName()` is the image stem), hand evaluation, Monte Carlo equity, and a functional hand engine in plain TypeScript with zero IO. `src/lib` is pure too: the chip peg and the one match on offer (`src/lib/economy.ts`: blinds, buy-in, entry fee, `SEAT_COST`, `HAND_CAP`, `STARTING_GRANT`), the chain registry, the rating, pacing, statistics, deposit-intent encoding, the ERC-8004 record shape. `src/server` is the layer that touches Postgres, the chain, and process state. API routes under `src/app/api` are thin and share one shape: a session where the route needs one (401), `take()` from `src/server/rate-limit.ts` (429), an id from `await context.params` checked with `isUuid` (404), parse the body, call one function in `src/server` (`actions`, `credentials`, `metrics`, `attestation`, `store`), and turn its `ActionError` or `RegistrationError` into a 400 carrying `{ error }`. Business logic lives in `src/server`.

**The table is the authority.** `src/agent/decide.ts` settles what the hand is, what it is worth (`equityVsRandom`), and which moves are legal (`legalActions`) before it asks anything. The reply is checked against the legal move set by `validateDecision` (`src/agent/decision.ts`); anything unusable checks when checking is free and folds otherwise, recorded as `timeout` or `error`. A late reply, a malformed frame, an illegal move and a dead socket all land in the same place, because from the table's point of view they are the same thing: the seat was silent. Equity numbers come from the server, and every action passes validation. The act clock starts after the equity simulation, and a re-ask after a reconnect keeps the same id and sends the `remainingMs` actually left.

**Two seat numberings.** The engine numbers the players in a hand densely from zero; the match numbers them by chair, and chairs go sparse as agents bust out. `MatchRuntime.lineup` is the one bridge, via `positionOf` and `chairOf`, and everything else treats the two as distinct. This is the most common source of bugs in `src/server/table.ts`. Related: the hand's final stacks are carried back onto `this.seated` after each hand, which is what makes the next hand deal from them and keeps chips conserved.

**Redaction happens on the server, in two layers.** Hole cards: the SSE route in `src/app/api/matches/[id]/stream/route.ts` re-renders any seat-carrying event as `runtime.view(viewerAgentId)` per subscriber, so another agent's hole cards are physically absent from the stream. Adding an event type that carries seat state means adding it to that re-render branch. That per-viewer render is the redaction, so each subscriber gets its own render, and the cost is bounded by capping viewers (`src/server/spectators.ts`). What describes a deciding seat's cards (its reasoning, its equity, its hand read) is held tighter, because the feed is public and those numbers name the holding as surely as showing it: `MatchRuntime` holds them until the hand ends, `view()` returns the brain through `sealBrain`, and `reveal` is the one event that carries them, sent for a seat that shows at showdown. `/api/hands/latest` applies the same rule to mucked hands afterwards, and it covers the seat's own owner too. Any new event carrying one of the three goes through `reveal`. Redaction is also as good as the shuffle: a real hand is dealt from `shuffledDeck()` (`src/server/deck.ts`, a CSPRNG), and the dealt order is stored on `hands.deck` for replay. `seed`/`mulberry32` is for tests and replays alone; a seat shown its hole cards and a flop can search a 32-bit seed space in seconds and read every opponent's cards.

**`src/lib/chains.ts` is the one file that names a network.** That registry holds one row per chain: id, token, public endpoint, explorer, faucet. `src/server/chains.ts` says which of them this deployment enabled and where their vaults are, reading `CHAINS` and a `<CHAIN>_RPC_URL` / `<CHAIN>_VAULT_ADDRESS` pair named after each key. Screens, wallet prompts, the SIWE message and `scripts/deploy-vault.sh` all read from those two, so adding a chain is a row plus two variables. Chain ids, token symbols, RPCs and explorer URLs all come from the registry, and `src/server/chain.ts` builds the viem chain from it too.

**The active chain is a cookie, and every money path re-resolves it.** `selectedChain()` reads it; `startDeposit` and `confirmDeposit` each take a chain key and resolve it themselves. A deposit is credited on the chain its intent was issued for, and is always finished on the chain it was paid on, whatever the player has since switched to. Chip balances are one number across every chain and stay put through a switch.

**Chips enter as the signup grant or a deposit, and leave as the entry fee.** `openSession` credits `STARTING_GRANT` when it creates an account; every chip after that is bought at the cashier. `src/dev/ledger-check.ts` audits that balance.

**Money is integers.** One chip is `WEI_PER_CHIP` (0.00001 of the chain's native token, the same figure on every chain) in both directions; pots and balances are integer chip counts, kept apart from floats and wei. Every balance change writes a row to `ledgerEntries` with `balanceAfter`, in the same transaction as the change. A deposit is credited after `observeDeposit` reads the receipt over our own RPC, confirms the log came from that chain's vault, and sees `REQUIRED_CONFIRMATIONS`; chain, tx hash and log index carry a unique index together, so one deposit event credits at most one intent while a transaction carrying several deposits credits each of them in the same `confirmDeposit` call.

**The web process is read-only on chain.** `src/server/chain.ts` holds a public client alone. `TREASURY_PRIVATE_KEY` belongs to `pnpm deploy:vault`, and `REGISTRAR_PRIVATE_KEY` and `ATTESTOR_PRIVATE_KEY` to `pnpm attest`, whose `src/dev/attest.ts` is the one importer of the publishing module `src/server/erc8004.ts`. Routes read attestations through `src/server/attestation.ts`.

**Pacing is a product feature.** `pacingFloor` holds a decision on screen longer the closer it sits to the break-even price, so hesitation reads as information. The model's own latency counts toward the floor. `ACT_CLOCK_MS` is the separate hard limit.

## Things that change together

- A frame change in `packages/protocol` fails to compile in `src/server` and `packages/agent`, and three more copies of the wire are text the compiler skips: `docs/PROTOCOL.md`, the frames shown in `src/components/connect-guide.tsx`, and the standalone JavaScript and Python agents in `src/components/agent-starters.ts`.
- `/api/health`'s fields are read by `scripts/health-watch.mjs`, which `.github/workflows/health.yml` runs against production every ten minutes (a failed run is the alert), and are explained in `docs/RUNBOOK.md`.
- A new `ledgerReason` in `src/db/schema.ts` gets named in `src/dev/ledger-check.ts`, whose conservation check fails until somebody decides which side of the books it belongs on.
- `MIN_PURCHASE` in `src/lib/economy.ts` is the vault's `minDeposit` in chips. A vault deployed with another `VAULT_MIN_DEPOSIT_WEI`, or changed with `setMinDeposit`, means changing it too, so the cashier offers exactly the purchases the vault accepts.
- The README's Contracts table lists the vaults production uses (`/api/chains` reports them). Deploying a new production vault means updating that table along with the deployment's `<CHAIN>_VAULT_ADDRESS`.

## Conventions

- Comments in this codebase explain why a thing is the way it is. Match that.
- Every text in the repository (comments, docs, UI copy, commit messages, PR bodies) states what was chosen, in positive terms, as what the product does or has. Phrasings like "no X", "without X", "X only", "instead of X", "rather than X", "unlike X" and lists of what was left out get rewritten as the positive fact. The em dash character appears nowhere; use commas, colons, semicolons, parentheses or periods.
- Tests that import server modules `import '../dev/test-env'` first, before any module that reads `DATABASE_URL`.
- Tests that need a real database import `../dev/test-db` first and skip when `TEST_DATABASE_URL` is unset. That database is named `*_test`, because the suite truncates every table; create it with `createdb` and migrate it with `DATABASE_URL=<it> pnpm db:migrate`. Anything that moves chips is tested there, through the real transactions.
- Migrations are generated: edit `src/db/schema.ts` then `pnpm db:generate`. SQL with an unchanged schema behind it goes through `pnpm db:generate --custom --name=<slug>` and is written to be idempotent. Drizzle's migrator applies what is newer than the last migration a database recorded, so a database that has run a branch's own migration can skip main's for good: regenerate a branch's migration after rebasing onto main, and keep branch migrations off databases that will later follow main. Production migrates on the replacement's boot while the outgoing process still runs the old code, so dropping or renaming something that code uses breaks it until it exits.
- `src/server/vault-abi.ts` is generated. Edit the contract and run `pnpm abi`.
- Path alias `@/*` maps to `src/*`; app code uses it, server-internal modules use relative imports.
- Next 16, per `AGENTS.md`: route handlers take `RouteContext<'/api/agents/[id]'>`, pages `PageProps<'/match/[id]'>`, layouts `LayoutProps<'/'>` (global types the build generates), and `params`, `cookies()` and `headers()` are all awaited.
- `next.config.ts` sends a CSP with `script-src 'self'` and `connect-src 'self'`: a page loads its own scripts and fetches its own origin. The browser reaches a chain through the injected wallet (`src/lib/wallet.ts`); everything else goes through this app's API.
- Colour is rationed, and the rules are the comments on `@theme` in `src/app/globals.css`: a neutral ramp, white as the one accent, red reserved for attention or failure, and every other hue belongs to an agent (`src/agent/colors.ts`, sampled from `public/chips`), so colour always carries meaning. Every page reached from the navigation opens with `PageHeader` from `src/components/ui.tsx`.

## Else

- Commit and push your own work, on the branch the task named. Work lands on
  `main` through pull requests, and a branch somebody else is working on gets
  ordinary pushes.
- A commit message says why the change is the way it is, the same as the
  comments do; the diff already shows what changed. Subjects are plain
  imperative sentences, and branches are named `<kind>/<slug>` (`fix/`,
  `chore/`, `docs/`, `ops/`).
- Opening a pull request is fine once the work is finished and `pnpm lint`,
  `pnpm test`, `pnpm build` and `pnpm exec tsc --noEmit` are all clean. In that
  order: the typecheck reads route types the build generates.
