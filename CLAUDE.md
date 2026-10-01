# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm dev                      # custom server: Next.js + agent sockets + the match engine
pnpm build                    # next build
pnpm start                    # NODE_ENV=production tsx server.ts (after build)
pnpm lint                     # eslint
pnpm exec tsc --noEmit        # typecheck, only after a build: it reads the route types the build writes to .next/types

pnpm test                     # node test runner via tsx over src/**/*.test.ts and packages/*/src/**/*.test.ts; seconds, no Postgres needed
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
AGENT_TOKEN=ah_... pnpm --filter @pokertunity/agent start       # one reference agent; heuristic unless AGENT_BRAIN=model
pnpm agent                    # one personal model-backed agent, configured in agents/.env
pnpm agent:second             # a second one, from agents/.env.second, so a pair can be run

pnpm abi                      # contracts/out/... -> src/server/vault-abi.ts (after forge build, on any contract change)
pnpm deploy:vault <chain-key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env, regenerates ABI
pnpm attest                   # publish agent records to the ERC-8004 registries (never done by the server)
```

Node >=24; pnpm is pinned by `packageManager`. `.env` is required; copy `.env.example`. `src/db/client.ts` throws on import without `DATABASE_URL`, and every session read or write throws without `SESSION_SECRET`. The server gets `.env` from Next, the `src/dev` scripts and `db:migrate` load it with dotenv, and `pnpm test` loads nothing, so `TEST_DATABASE_URL` goes on the command line. Leave `APP_ORIGIN` blank in development: sign-in is bound to it, so setting it pins sign-in to one host. `HAND_CAP` defaults to 100 hands, about eighty minutes with pacing; set it low locally to watch a match end. `CHAINS` names the networks on offer by their key in `src/lib/chains.ts`; each needs a `<CHAIN>_VAULT_ADDRESS` before chips can be bought on it. `contracts/lib/forge-std` is a git submodule; run `git submodule update --init` before `forge test`. A build that fails on types for routes that no longer exist has a stale `.next`, usually after a branch switch: `rm -rf .next tsconfig.tsbuildinfo`.

`docs/` holds the long form: `ARCHITECTURE`, `PROTOCOL` (the wire, frame by frame), `DEPLOY`, `RUNBOOK`, `CONTRIBUTING`, `PRELAUNCH`. This file is the compressed, normative version. Every decision recorded here is also written out in a code comment where it applies, so changing one means changing the comment, this file and the doc together; where they disagree, the code settles it.

Agents think on their owners' model keys, which keeps the arena's cost flat as the field grows. `AGENT_BRAIN=heuristic` in `packages/agent` plays off the numbers the arena already sent and needs no key at all.

## Architecture

**`server.ts` is the entrypoint, not `next start`.** Next cannot accept a WebSocket and agents dial in over one, so the HTTP server is ours: it wraps Next, routes `/agent` upgrades to the socket layer and everything else to Next's own upgrade listener, and boots the engine. Three things share memory on purpose — the dealer holds match state, the sockets feed it, the spectator stream reads it. `getRequestHandler()` must be called _after_ `prepare()`, and `server.ts` imports its own server modules with `await import()` after it too, because they read environment Next loads. Next is handed a throwaway `httpServer` it never listens on, and every upgrade that is not an agent's is re-emitted onto it; `getUpgradeHandler()` is not used, because it routes to an empty handler and hot reload hangs. On the first request Next attaches an upgrade listener of its own to whatever that option names, falling back to the server the request arrived on, and in production that listener ends every upgrade it does not recognise. Without the decoy, agent sockets connect and die a millisecond later, but only once a page has been served. `src/instrumentation.ts` is deliberately empty: booting from there too gives Next's module graph its own copy of the advisory lock and the two boots fight over it.

**Standalone output cannot be used.** Next does not trace custom server files in that mode and emits its own `server.js` instead. The Dockerfile therefore ships the full dependency tree. The build stage sets a placeholder `DATABASE_URL` because `next build` evaluates every route module and `src/db/client.ts` refuses to load without one; nothing connects at build time and the placeholder does not survive into the runtime stage. `railway.json` pins one replica. `server.ts` applies migrations itself on every production boot, before it listens (`src/db/apply-migrations.ts`), so the server never runs ahead of its schema. A failed migration ends the process, so the health check keeps the old deployment live. `bootEngine` re-offers for the lock every fifteen seconds rather than claiming once, because an overlapping deploy starts the replacement while the outgoing process still holds it.

**A statically prerendered page freezes its environment at build time.** `next build` evaluates page modules to collect page data, so anything a page reads from `process.env` at module load — `MATCH.handCap` via `HAND_CAP`, most obviously — is baked into the HTML inside the Docker build stage, where only `DATABASE_URL` and `NEXT_TELEMETRY_DISABLED` are set. The page then ships that value and the edge serves it for as long as its `s-maxage` says. A page whose copy depends on configuration must either read it in a server component and pass it down, or opt out of prerendering; adding the variable to the build stage looks like a fix and only moves the disagreement. A `'use client'` component that reads `MATCH.handCap` shows the default too, because no browser bundle carries server environment: `/matches` is `force-dynamic` and passes `handCap` down as a prop.

**Agents dial in; the arena never dials out.** `src/server/socket.ts` holds the sockets, `src/server/presence.ts` is the registry everything else talks to, and nothing above the socket layer imports a WebSocket library. Presence is not a column: a socket is a fact about this process, and writing it down would leave a stale "connected" behind after a crash. Connecting is not the same as asking for a game — an agent must send `ready`, or nobody could debug against production without being seated in a match that then plays to the end. Asking is not enough either: the owner's *Play matches* switch (`agents.queueEnabled`, off for a new agent, on for seeded ones) gates `queuedAgents`, and each connection dedupes its own `queued` frames via `AgentLink.tellQueue`.

**Every act frame carries a correlation id and the reply must echo it.** An agent that times out and answers a second late is ordinary, not rare, and without the check its answer to hand four gets applied to hand five. Frames are capped at 200 a second and 8KB each, reasoning at 4KB a decision (the constants live in `packages/protocol`), and a breach closes the socket with a stated reason rather than dropping it silently. The byte budget is the real bound; the frame rate is loose so that an agent forwarding a model's token stream frame by frame is not punished for it.

**Seat numbers on the wire are chairs.** The engine renumbers players densely as agents bust; `decide()` maps positions to chairs via the `chairs` option so an agent's seat number means the same thing all match.

**The engine is not a request handler.** `bootEngine()` runs once per process. That takes a Postgres advisory lock (`src/server/engine-lock.ts`); only the process that wins it deals, and every other instance serves pages. The winner first abandons any match a dead process left mid-hand, then starts the matchmaker. Match state lives in memory, so the lock is what stops two processes dealing the same hand twice. Process state hangs off `globalThis`, for a bigger reason than hot reload: `server.ts` loads `src/server/*` through tsx while Next bundles its own copy of those modules into the routes, so a module-level variable holds one value for the engine and another for every route, and the room deals while `/api/health` insists it is not. The registry, presence, engine lock, matchmaker timer, unsettled matches, socket server and database pool live there; anything the engine writes and a route reads must too. `POKERTUNITY_DISABLE_ENGINE=1` suppresses the boot. Consequences of living in memory: the SSE stream route answers 503 on an instance that is not dealing, and `/api/health` reports `dealing` and when a hand last finished rather than a bare "ok".

**Matches are ephemeral, and the matchmaker makes every one.** `src/server/matchmaker.ts` reads the queue every few seconds, bands agents by rating, and calls `createMatch`, which charges every entrant `SEAT_COST` and writes their seats in one transaction. `openMatch` then puts a `MatchRuntime` on it. A match's field is fixed from the first hand to the last. It ends when one agent holds every chip or `handCap` hands are up. The runtime is dropped at once, and `settleMatch` returns the stacks, records the finishing order and rewrites every rating, retried every tick until it lands. An agent's only lever is the `ready` and `stop` frames, which decide whether it queues again.

Matchmaker details that are easy to break: ticks never overlap (an overlapping tick would read the same agents as unseated and charge them twice). How long an agent has waited comes from `AgentLink.readySince`, stamped on the socket when it first says `ready`, never from a row's timestamp, because the rating band widens with the wait. One owner never gets two seats at one table. `queuedAgents` silently drops agents whose owner cannot cover `SEAT_COST`, so the matchmaker separately sends them a `queued` frame with the reason, only when that reason changes.

**Rating is pure and lives in `src/lib/rating.ts`.** A Thurstone-Mosteller pairwise update over the finishing order, damped by `1/sqrt(n-1)` so one six-handed table is not treated as five independent results. `conservative()` (mu minus three sigma) is the published number; mu alone is never ranked on. Nothing outside that module may invent a rating figure.

**Layering, strict.** `packages/protocol` is the wire, imported by both sides so one edit to a frame fails to compile twice. `packages/agent` is the reference agent and, with `agents/` built on it, the only code that holds a model key or calls a model. `src/poker` is pure: cards (an integer 0..51, suits ordered like the `public/cards` filenames so `cardName()` is the image stem), hand evaluation, Monte Carlo equity, and a functional hand engine with no framework and no IO. `src/lib` is pure too: the chip peg and the one match on offer (`src/lib/economy.ts`: blinds, buy-in, entry fee, `SEAT_COST`, `HAND_CAP`, `STARTING_GRANT`), the chain registry, the rating, pacing, statistics, deposit-intent encoding, the ERC-8004 record shape. `src/server` is the only layer that touches Postgres, the chain, or process state. API routes under `src/app/api` are thin and share one shape: a session where the route needs one (401), `take()` from `src/server/rate-limit.ts` (429), an id from `await context.params` checked with `isUuid` (404), parse the body, call one function in `src/server` (`actions`, `credentials`, `metrics`, `attestation`, `store`), and turn its `ActionError` or `RegistrationError` into a 400 carrying `{ error }`. Business logic does not belong in a route.

**The agent is never an authority.** `src/agent/decide.ts` settles what the hand is, what it is worth (`equityVsRandom`), and which moves are legal (`legalActions`) before it asks anything. The reply is checked against the legal move set by `validateDecision` (`src/agent/decision.ts`); anything unusable checks when checking is free and folds otherwise, recorded as `timeout` or `error` rather than as a fold. A late reply, a malformed frame, an illegal move and a dead socket all land in the same place, because from the table's point of view they are the same thing: nobody acted. Never let an agent produce an equity number or an action that skips validation. The act clock starts after the equity simulation, not when `decide()` is entered, and a re-ask after a reconnect keeps the same id but sends the `remainingMs` actually left.

**Two seat numberings.** The engine numbers the players in a hand densely from zero; the match numbers them by chair, and chairs go sparse as agents bust out. `MatchRuntime.lineup` is the only bridge, via `positionOf` and `chairOf`. Nothing outside those may assume the numbers agree. This is the most common source of bugs in `src/server/table.ts`. Related: the hand's final stacks must be carried back onto `this.seated` after each hand, or every hand deals from the buy-in again and chips stop conserving.

**Redaction happens on the server, in two layers.** Hole cards: the SSE route in `src/app/api/matches/[id]/stream/route.ts` re-renders any seat-carrying event as `runtime.view(viewerAgentId)` per subscriber instead of forwarding it, so another agent's hole cards are physically absent from the stream. Adding an event type that carries seat state means adding it to that re-render branch. That per-viewer render is the redaction, so never share one rendered event across subscribers to save work; the cost is bounded by capping viewers instead (`src/server/spectators.ts`). What describes a deciding seat's cards — its reasoning, its equity, its hand read — is held tighter, because the feed needs no sign-in and those numbers name the holding as surely as showing it: `MatchRuntime` never publishes them while the hand is live, `view()` returns the brain through `sealBrain`, and the only event that carries them is `reveal`, sent for a seat that shows at showdown. That is the same rule `/api/hands/latest` applies to mucked hands afterwards, and the seat's own owner is not an exception. Never add an event that carries any of the three outside `reveal`. Redaction is also only as good as the shuffle: a real hand is dealt from `shuffledDeck()` (`src/server/deck.ts`, a CSPRNG), and the dealt order is stored on `hands.deck` for replay. Never deal a played hand from `seed`/`mulberry32`; a seat shown its hole cards and a flop can search a 32-bit seed space in seconds and read every opponent's cards.

**No file above `src/lib/chains.ts` names a network.** That registry holds one row per chain: id, token, public endpoint, explorer, faucet. `src/server/chains.ts` says which of them this deployment enabled and where their vaults are, reading `CHAINS` and a `<CHAIN>_RPC_URL` / `<CHAIN>_VAULT_ADDRESS` pair named after each key. Screens, wallet prompts, the SIWE message and `scripts/deploy-vault.sh` all read from those two, so adding a chain is a row plus two variables. Never hard-code a chain id, a token symbol, an RPC or an explorer URL anywhere else, and never import a chain from `viem/chains`: `src/server/chain.ts` builds the viem chain from the registry.

**The active chain is a cookie, and every money path re-resolves it.** `selectedChain()` reads it; `startDeposit` and `confirmDeposit` each take a chain key and resolve it themselves rather than trusting a caller. A deposit is credited only on the chain its intent was issued for, and is always finished on the chain it was paid on, whatever the player has since switched to. Chip balances are one number across every chain and a switch does not move them.

**Chips enter as the signup grant or a deposit, and leave as the entry fee.** `openSession` credits `STARTING_GRANT` when it creates an account; every chip after that is bought at the cashier. `src/dev/ledger-check.ts` audits that balance.

**Money is integers.** One chip is `WEI_PER_CHIP` (0.00001 of the chain's native token, the same figure on every chain) in both directions; pots and balances are integer chip counts and never touch a float or a wei value. Every balance change writes a row to `ledgerEntries` with `balanceAfter`, in the same transaction as the change. Deposits are credited only after `observeDeposit` reads the receipt over our own RPC, confirms the log came from that chain's vault, and sees `REQUIRED_CONFIRMATIONS`; chain, tx hash and log index carry a unique index together, so one deposit event credits at most one intent while a transaction carrying several deposits credits each of them in the same `confirmDeposit` call.

**The web process holds no key that can write on chain.** `src/server/chain.ts` is read-only and has no wallet client. `TREASURY_PRIVATE_KEY` is read only by `pnpm deploy:vault`, and `REGISTRAR_PRIVATE_KEY` and `ATTESTOR_PRIVATE_KEY` only by `pnpm attest`, whose `src/dev/attest.ts` is the only importer of the publishing module `src/server/erc8004.ts`. Routes read attestations through `src/server/attestation.ts` and must never import `erc8004.ts`.

**Pacing is a product feature.** `pacingFloor` holds a decision on screen longer the closer it sits to the break-even price, so hesitation reads as information. The model's own latency counts toward the floor. `ACT_CLOCK_MS` is the separate hard limit.

## Things that change together

- A frame change in `packages/protocol` fails to compile in `src/server` and `packages/agent`, but three copies of the wire are text the compiler never checks: `docs/PROTOCOL.md`, the frames shown in `src/components/connect-guide.tsx`, and the standalone JavaScript and Python agents in `src/components/agent-starters.ts`.
- `/api/health`'s fields are read by `scripts/health-watch.mjs`, which `.github/workflows/health.yml` runs against production every ten minutes (a failed run is the alert), and are explained in `docs/RUNBOOK.md`.
- A new `ledgerReason` in `src/db/schema.ts` must be named in `src/dev/ledger-check.ts`, whose conservation check fails until somebody decides which side of the books it belongs on.
- `MIN_PURCHASE` in `src/lib/economy.ts` is the vault's `minDeposit` in chips. A vault deployed with another `VAULT_MIN_DEPOSIT_WEI`, or changed with `setMinDeposit`, means changing it, or the cashier offers purchases the vault reverts.
- The README's Contracts table lists the vaults production uses (`/api/chains` reports them). Deploying a new production vault means updating that table along with the deployment's `<CHAIN>_VAULT_ADDRESS`.

## Conventions

- Comments in this codebase explain why a thing is the way it is, not what the line does. Match that.
- Tests that import server modules must `import '../dev/test-env'` first, before any module that reads `DATABASE_URL`.
- Tests that need a real database import `../dev/test-db` first instead and skip without `TEST_DATABASE_URL`. That database must be named `*_test`, because the suite truncates every table; create it with `createdb` and migrate it with `DATABASE_URL=<it> pnpm db:migrate`. Anything that moves chips is tested there, through the real transactions, not against a mock.
- Migrations are generated, never hand-written; edit `src/db/schema.ts` then `pnpm db:generate`. SQL with no schema change behind it goes through `pnpm db:generate --custom --name=<slug>` and is written to be idempotent. Drizzle's migrator applies only what is newer than the last migration a database recorded, so a database that has run a branch's own migration can skip main's for good: regenerate a branch's migration after rebasing onto main, and keep branch migrations off databases that will later follow main. Production migrates on the replacement's boot while the outgoing process still runs the old code, so dropping or renaming something that code uses breaks it until it exits.
- `src/server/vault-abi.ts` is generated. Edit the contract and run `pnpm abi`.
- Path alias `@/*` maps to `src/*`; app code uses it, server-internal modules use relative imports.
- Next 16, per `AGENTS.md`: route handlers take `RouteContext<'/api/agents/[id]'>`, pages `PageProps<'/match/[id]'>`, layouts `LayoutProps<'/'>` (global types the build generates), and `params`, `cookies()` and `headers()` are all awaited.
- `next.config.ts` sends a CSP with `script-src 'self'` and `connect-src 'self'`: a page loads no third-party script and fetches no other origin. The browser reaches a chain only through the injected wallet (`src/lib/wallet.ts`); everything else goes through this app's API.
- Colour is rationed, and the rules are the comments on `@theme` in `src/app/globals.css`: a neutral ramp, white as the one accent, red for attention or failure only, and every hue not listed there belongs to an agent (`src/agent/colors.ts`, sampled from `public/chips`), so colour never decorates. Every page reached from the navigation opens with `PageHeader` from `src/components/ui.tsx`.

## Else

- Commit and push your own work, on the branch the task named. Never straight to
  `main`, and never a force-push to a branch somebody else is working on.
- A commit message says why the change is the way it is, the same as the
  comments do. What changed is already in the diff. Subjects are plain
  imperative sentences with no `feat:`-style prefix, and branches are named
  `<kind>/<slug>` (`fix/`, `chore/`, `docs/`, `ops/`).
- Opening a pull request is fine once the work is finished and `pnpm lint`,
  `pnpm test`, `pnpm build` and `pnpm exec tsc --noEmit` are all clean. In that
  order: the typecheck reads route types the build generates.
