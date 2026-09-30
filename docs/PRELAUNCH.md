# Pre-launch checklist

Four scopes, four owners, one launch gate. Every item carries the command, what
you should see, and the test that says you are done, so nobody has to guess what
"finished" means.

The arena works. The money path has never touched a chain. That sentence is the
whole reason this document exists.

- [Ground rules](#ground-rules)
- [Where the project stands](#where-the-project-stands)
- [The four scopes](#the-four-scopes)
- [Scope A — Chain, vault and the money path](#scope-a--chain-vault-and-the-money-path)
- [Scope B — Hardening and capacity](#scope-b--hardening-and-capacity)
- [Scope C — Wallet and interface QA](#scope-c--wallet-and-interface-qa)
- [Scope D — Deploy and operations](#scope-d--deploy-and-operations)
- [Sequencing](#sequencing)
- [The launch gate](#the-launch-gate)

## Ground rules

These are from [CLAUDE.md](../CLAUDE.md) and are not style preferences.

1. Work on a branch, never `main`. Never force-push a branch somebody else is on.
2. Four gates, in this order, all clean before a pull request:

   ```bash
   pnpm lint
   TEST_DATABASE_URL=postgres://pokertunity:pokertunity@localhost:5432/pokertunity_test pnpm test
   pnpm build
   pnpm exec tsc --noEmit
   ```

   The typecheck runs last because it reads route types the build generates.
3. Migrations are generated, never hand-written. Edit `src/db/schema.ts`, then
   `pnpm db:generate`.
4. Comments explain why, not what. Commit messages follow the same rule; the
   diff already says what changed.
5. Never invent a rating figure outside `src/lib/rating.ts`, never name a chain
   outside `src/lib/chains.ts`, and never add an event carrying reasoning,
   equity or a hand read outside `reveal`.

Local setup is in the [README](../README.md). Two things it is worth repeating:
leave `APP_ORIGIN` blank in development, or sign-in pins to one host and a
wallet refuses every other; and run `pnpm db:spare field.json` after seeding, so
one agent stays queued and a newcomer is seated in seconds rather than waiting
out somebody else's match.

## Where the project stands

### Verified end to end

Exercised against a running arena in production mode, not only in unit tests.

| Area | Evidence |
| --- | --- |
| Four gates | lint clean, 213/213 tests, build ok, `tsc` clean |
| Contracts | 11/11 Foundry tests |
| Full match | Six-handed, dealt to the hand cap, settled, ratings rewritten |
| Chip conservation | 6 × 2,000 in, exactly 12,000 out |
| Ledger integrity | No break in `balance_after`, no cache drift, the entry fee the only sink |
| Redaction | Anonymous viewer sees `hole: null` and a sealed brain |
| Engine lock | A second instance serves pages and refuses to deal |
| Graceful shutdown | Every agent got a stated reason and reconnected with backoff |
| Crash recovery | Dealer killed mid-match: stacks returned, hand count kept, nobody rated |
| Sign-in | Real signature over SIWE, session issued, agent registered, token connected |
| Socket refusals | Bad token 4001, wrong version 4002, each with a sentence |
| Deposit path, local chains | Every A4 check, see below |
| Spectator load | Four live tables to 8,000 streams, see B3 |

**The deposit rehearsal.** Two local chains carrying the production chain ids
(97 and 421614), each with the current `ChipVault`, and the arena reading
receipts over its own RPC exactly as it would a testnet. From a real SIWE
session: a Starter deposit credited 10,000 chips once; confirming it again
credited nothing; an intent priced on Arbitrum and paid on BNB was refused;
another wallet paying the intent credited neither account; half the price was
refused; and a deposit stayed pending until its third confirmation. What this
does not prove is a public testnet: its
RPC, its finality and a wallet driven by a person. That is still A4.

### Never exercised

- **A deposit on a public testnet.** The logic is rehearsed (above); the
  network is not.
- **ERC-8004 attestation.** `pnpm attest` has run against forks of all three
  testnets, never against the testnets themselves.
- **The browser.** Only status codes and JSON were checked. No wallet, no eyes.
- **Production hardware.** Every capacity number here is from a developer
  machine.

### Closed since this list was first written

1. The read routes are rate limited (B1), and strangers are now counted by the
   address Railway's edge appended rather than the first entry of
   `x-forwarded-for`, which the caller writes. Before that, a random header
   walked past every signed-out limit.
2. Spectators are capped per match, per caller and per process (B2, B3).
3. The esbuild advisory is patched, not accepted (B4).
4. Rotation's effect on a live socket is decided and documented (C3 step 9).
5. A deposit paid on the wrong chain is told the truth: it cannot be credited,
   rather than to switch networks and poll a transaction that is not there.
   The deposit transaction now names its `chainId`, so a wallet switched
   while the prompt was open refuses it instead of paying the wrong vault.

## The four scopes

Drawn so four people can work the same week without touching each other's files.
Only Scope B writes application code.

| Scope | Mission | Blocker | Effort |
| --- | --- | --- | --- |
| A — Chain and money | Deploy the vault, prove a real deposit credits real chips | Yes | 2–3 days, mostly waiting on faucets |
| B — Hardening and capacity | Close the four findings, measure the fan-out ceiling | No | 2–3 days |
| C — Wallet and interface QA | Drive every flow a human can reach, file what breaks | No | 2 days |
| D — Deploy and operations | Railway, secrets, prove the runbook | No | 2 days |

Branch per scope: `scope-a/vault-deploy`, `scope-b/read-route-limits`. Tick an
item when its done-test passes, not when the change is written.

## Scope A — Chain, vault and the money path

Nothing here has ever accepted a real deposit. Make that sentence false.

Start A1 today: every faucet gates on a captcha or a mainnet balance, so funding
is the long pole and it is pure waiting.

### A1. Fund a throwaway wallet

Generate a fresh key used nowhere else. Testnet only, never a key that has
touched mainnet.

| Chain | Key | Faucet |
| --- | --- | --- |
| BNB Smart Chain Testnet | `bnb-testnet` | `testnet.bnbchain.org/faucet-smart` |
| Arbitrum Sepolia | `arbitrum-sepolia` | `alchemy.com/faucets/arbitrum-sepolia` |
| Monad Testnet | `monad-testnet` | `faucet.monad.xyz` |

Deployment costs well under a thousandth of a token.

**Done when:** the address holds a non-zero balance on at least one chain.

### A2. Deploy ChipVault

Set `TREASURY_PRIVATE_KEY` and `VAULT_OWNER`, then per chain:

```bash
pnpm deploy:vault bnb-testnet
```

The script names the chain by its registry key, so the id, endpoint and explorer
link all come from one place. It writes `BNB_TESTNET_VAULT_ADDRESS` back into
`.env` and regenerates the ABI. A zero balance makes it print the faucet and stop.

**Done when:** `pnpm abi` produces no diff, so the committed ABI matches the
deployed contract.

Write the addresses here as well as in the environment. An address that lives
only in somebody's `.env` is how this document came to say "deployed" about
vaults nobody else could find.

| Chain | Vault | Deploy transaction |
| --- | --- | --- |
| `bnb-testnet` | | |
| `arbitrum-sepolia` | | |
| `monad-testnet` | | |

### A3. Verify on the explorer

Verification is per explorer, not per chain: only Etherscan-style APIs have an
entry in `contracts/foundry.toml`. Register for a BscScan and an Arbiscan key,
set `<CHAIN>_EXPLORER_API_KEY`, and pass `--verify`.

**Done when:** the source is readable on the explorer. Monad has no
Etherscan-style API; record it as unverified rather than chasing it.

### A4. Put a real deposit through

The item the whole scope exists for. Sign in with the funded wallet, open the
cashier, buy the Starter package, watch the chips arrive.

The server credits only after reading the receipt over its own RPC and
confirming all five: the log came from that chain's vault, the intent was issued
for that same chain, the payer is the signed-in wallet, the amount covers the
package, and the transaction has three confirmations.

- Chips credited, exactly once
- A `deposit` row in `ledger_entries` with a correct `balance_after`
- Confirming the same transaction twice credits nothing the second time
- A deposit priced on one chain and paid on another is refused

**Done when:** a deposit credits once and a replay of it credits nothing.

### A5. ERC-8004 attestation, on every chain

Part of the MVP: each chain is submitted on its own, so each needs an identity
and a reputation record on it. Needs the registry addresses per chain,
`REGISTRAR_PRIVATE_KEY` and `ATTESTOR_PRIVATE_KEY` funded on every chain, and a
`PUBLIC_BASE_URL` reachable from outside.

The registries are the ERC-8004 team's singletons from
github.com/erc-8004/erc-8004-contracts, chosen because they are the ones the
specification's authors curate and the ones indexers read. They were checked to
hold code on all three chains. None of those lists a Validation Registry, since
the specification still has it under revision, so validation is optional and
unset.

Fork-test first (see DEPLOY.md §7), then `pnpm attest`.

The running server never touches a registry. Attestation is a separate command
with its own keys. Keep it that way.

**Done when:** one agent has an identity and a reputation record on each of the
three chains, with transaction hashes to show, and
`/api/agents/<id>/registration` lists all three.

## Scope B — Hardening and capacity

Every mutating and authentication route is rate limited. No read route is, and
there is no global middleware. Read `src/server/rate-limit.ts` first: the pattern
you need exists and is already tested.

**Status: done.** B1, B2 and B4 merged; B3 measured and a process ceiling
added from it. What is left for this scope is re-measuring on the hardware it
will run on, once D1 exists.

### B1. Rate limit the read routes

| Route | Why it matters |
| --- | --- |
| `/api/agents/[id]/axes` | Worst. Public, unauthenticated, scans up to 5,000 rows, then computes in memory |
| `/api/leaderboard` | Aggregate over every hand ever played |
| `/api/hands/latest` | Reads a whole hand plus its decisions |
| `/api/matches` | Polled by every open lobby |

`/api/health`, `/api/chains`, `/api/account` and `/api/auth/logout` are cheap.
Judge them yourself: a limit on health can hide an outage from your own
monitoring.

```ts
const allowed = take('<bucket>', callerOf(request, null));
if (!allowed.ok) return tooMany(allowed.retryAfterMs);
```

Size each bucket to the query's real cost; `axes` should be far tighter than
`matches`. Extend `src/server/rate-limit.test.ts` to cover them.

**Done when:** hammering `axes` returns 429 with a `retry-after`, and the suite
proves the quoted wait is long enough to actually succeed.

### B2. Cap concurrent spectators per match

`TableBus` holds an unbounded `Set`. The stream route re-renders
`runtime.view(viewer)` per subscriber per event, because redaction is per viewer,
which is correct and is exactly why the cost is O(N) on the dealing process.

Add a ceiling in `src/app/api/matches/[id]/stream/route.ts` and answer 503 with a
`retry-after` over it, matching how that route already answers when this instance
is not dealing. Consider a per-caller cap too: one client opening fifty streams
is the shape to stop.

> Never "fix" this by sharing one rendered event across subscribers. That puts
> one viewer's hole cards in another viewer's stream.

### B3. Measure the ceiling before choosing it

Done on a developer machine: four live six-seat tables, streams from distinct
addresses, two minutes a step, the load generator on the same machine.

| Streams | Hand p50 / p90 | Event loop p99 / max | CPU | RSS |
| --- | --- | --- | --- | --- |
| 0 | 64s | 34 / 36ms | 2% | 94MB |
| 1,000 | 74 / 80s | 63 / 135ms | 6% | 170MB |
| 2,000 | 67 / 83s | 62 / 76ms | 8% | 173MB |
| 4,000 | 69 / 74s | 94 / 123ms | 12% | 294MB |
| 8,000 | 74 / 82s | 380 / 439ms | 21% | 560MB |

Hand times are pacing and never moved. The event loop did, between 4,000 and
8,000. `PROCESS_SPECTATOR_CAP` is 2,000, half the last flat point; the match
ceiling stays 500. Event-loop figures are `/api/health` round trips, which is
what a person loading a page would feel.

Repeat this on the deployed instance before raising either number.

What was originally asked:

Open subscribers against one live match in steps of 10, 50, 100, 250. At each
step record hand duration, `idleSeconds` from `/api/health`, and the dealing
process's CPU and memory. Find where pacing starts to slip and set the cap below
it. Put the numbers in the pull request: whoever raises the cap later needs to
know what it was measured against.

### B4. The esbuild advisory

GHSA-67mh-4wv8-2f99, via `drizzle-kit > @esbuild-kit/esm-loader > esbuild`.
Confirm the path is devDependencies only and that the vulnerability targets a dev
server, then either patch it or write one paragraph accepting it. Do not fork a
build tool over a dev-only advisory.

### Not your job

The redaction design, the rating maths and the engine lock are verified. If a
change needs to touch `src/lib/rating.ts` or the `reveal` event, stop and raise
it; you have probably found a different problem.

## Scope C — Wallet and interface QA

Sign-in was verified by signing a SIWE message with a raw key over HTTP, which
proves the server and nothing about a wallet. Nobody has clicked a signature
prompt, switched a network, or looked at a screen.

File bugs, do not fix them. Give each one the URL, the wallet state, what you
expected and what happened.

Setup: `APP_ORIGIN` blank, arena on `http://localhost:3000`, field connected, a
fresh wallet account. No testnet funds needed except for C4; a new account gets
10,000 chips, once.

### C1. Sign-in

| # | Test | Expected |
| --- | --- | --- |
| 1 | No wallet installed | "No wallet found. Install MetaMask…", not a crash |
| 2 | Connect and approve | Prompt shows `localhost:3000` and says it costs nothing |
| 3 | Reject the signature | "Sign-in cancelled.", page still usable |
| 4 | Reload after signing in | Still signed in; the session is a seven-day cookie |
| 5 | Sign out, reload | Signed out and stays out |
| 6 | Browse `127.0.0.1:3000` | Works identically, prompt names that host |
| 7 | Browse a LAN address from a phone | Works identically |

Tests 6 and 7 exist because a pinned `APP_ORIGIN` silently breaks them.

### C2. Network switching

Sign in from another network and you are asked to switch. Reject it and the error
must be readable with no half-signed-in state. Switching to Monad Testnet is the
path most likely to be broken, because most wallets have never heard of it and it
has to be added from the registry. Switching chains in the header must not change
your chip balance: one balance spans every chain.

### C3. The owner journey

1. Sign in; you have 10,000 chips
2. Register an agent; the `ah_…` token is shown **once**, and leaving and
   returning must not show it again
3. Connect it:
   `ARENA_URL=ws://localhost:3000/agent AGENT_TOKEN=ah_… AGENT_BRAIN=heuristic pnpm --filter @pokertunity/agent start`
4. The account page shows it connected and queued
5. It is seated within seconds, because of the spare agent
6. Watching your own match, you see your own hole cards and nobody else's
7. In a signed-out private window, **no hole cards at all**. If this fails, stop
   everything and escalate
8. The match ends, your rating moves, the standings update
9. Rotating the token refuses the old one on the **next** connection, and the
   agent already playing keeps playing. Cutting it off mid-hand would cost its
   owner a match, so it is left alone deliberately — see the note below before
   testing this one. Then start the agent on the new token: the old connection
   closes with "This agent connected again from somewhere else." and the seat
   carries on
10. The ninth agent is refused: "One account can run 8 agents."

> **Rotation is maintenance, not eviction.** It stops the old token opening new
> connections; it does nothing to a connection already authenticated on one. An
> owner rotating because a token leaked closes that by connecting their own
> agent on the new token: a second connection for an agent replaces the first,
> and the seat belongs to the agent, so the match carries on in their hands.
> Without that, whoever holds the old token keeps the seat until the socket
> drops — up to a full match. Decided this way on [#38](https://github.com/Fatihmaull/pokertunity/issues/38):
> the cost of cutting the wire lands on every routine rotation, and the cost of
> leaving it lands only on a leak the owner can close by stopping their agent.

### C4. Cashier

Signing in again must add nothing: the signup grant is credited once, when the
account is created. On a chain whose vault address is unset, buying must be
refused by name: "Chips cannot be bought on BNB Smart Chain Testnet yet." After
Scope A finishes, pair with them on the real deposit.

### C5. Look at it

Nobody has. Each screen, light and dark, laptop and phone.

| Screen | Watch for |
| --- | --- |
| `/` | The live hand hero, and what it shows when no match is running |
| `/matches` | Live and finished matches; a finished one must name who played |
| `/match/[id]` | The felt, the Brain Visualizer, the clock, the pacing |
| `/standings` | An unrated agent reads "unrated" rather than 0.0 |
| `/agent` | Token handling, the agent list, the cashier |

No horizontal scrolling on a phone, text readable in both themes, nothing
shifting as live data arrives. Watch one hand reach showdown and confirm the
reasoning and equity appear only then.

## Scope D — Deploy and operations

Read [DEPLOY.md](DEPLOY.md) and [RUNBOOK.md](RUNBOOK.md) first. Nothing here waits
on Scope A except the vault addresses, which are environment variables added
later.

### D1. Railway

```bash
railway init
railway add --database postgres
railway up
railway domain                    # then put that URL in APP_ORIGIN and redeploy
```

`railway.json` already names the Dockerfile builder and pins one replica, and the
server applies the migrations itself before the new instance takes traffic. Do not raise `numReplicas`:
match state lives in memory, so a second instance correctly serves pages and
refuses to deal, which is right but pointless.

**Done when:** `/api/health` returns `ok: true` and `dealing: true`.

### D2. Environment

| Variable | Value | Note |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | A Railway reference, not a literal |
| `SESSION_SECRET` | `openssl rand -base64 32` | Fresh, never one from a laptop |
| `APP_ORIGIN` | `https://<domain>` | Required in production; sign-in throws without it |
| `CHAINS` | `bnb-testnet,arbitrum-sepolia,monad-testnet` | |
| `DEFAULT_CHAIN` | `bnb-testnet` | |
| `<CHAIN>_VAULT_ADDRESS` | from Scope A | Without one a chain is watchable but not buyable |
| `HAND_CAP` | see D4 | |

`PORT` is Railway's. Nothing model-related belongs here: the arena holds no model
key, and that is what stops its cost scaling with the number of players.

### D3. Secrets

The repository is public. Treat every secret as if it will be seen.

`SESSION_SECRET` generated fresh for production and stored in a password manager.
`TREASURY_PRIVATE_KEY` and `ATTESTOR_PRIVATE_KEY` testnet-only, throwaway, and
different from each other; neither is ever set on the web service. Confirm the
running service holds no key that can write on chain. Agent tokens start with
`ah_` so a leaked one is recognisable in a log or a public repository: rotate
rather than investigate.

### D4. Choose the hand cap

Unset it is 100, roughly two hours with pacing. `30` is about twenty-five minutes,
which a visitor can watch reach an end.

There is a trap here that has already shipped once. A statically prerendered page
evaluates `process.env` at build time, inside the Docker build stage where
`HAND_CAP` is not set: `/matches` once told visitors the game was 100 hands while
every match ran 30. A page whose copy depends on configuration must read it in a
server component or opt out of prerendering. Adding the variable to the build
stage looks like a fix and only moves the disagreement.

**Done when:** the number on the page and the number in the engine agree.

### D5. Monitoring

`/api/health` is deliberately richer than `ok`, because a process that answers
requests is not the same as a room that deals. Alert on `ok` false (the database
is unreachable), `dealing` false on the only replica (nobody is running the room),
`unsettled` above zero for more than a tick or two (stacks stuck on a closed
table), and `idleSeconds` climbing while agents are seated (the engine stalled).

**In place:** `.github/workflows/health.yml` runs `scripts/health-watch.mjs`
against production every ten minutes. It fails the run, and GitHub emails, on
all four conditions above. An empty room is deliberately not one of them:
production runs no agents of its own, so nobody seated only means nobody has
brought one. Scheduled runs can start late under load on GitHub's side, so treat
this as a tripwire rather than a pager. Run it by hand with
`HEALTH_URL=https://<domain>/api/health node scripts/health-watch.mjs`.

### D6. Rehearse an incident

On the deployed instance, with agents connected: restart the service mid-match.
Agents must get a stated reason and reconnect on their own; the replacement must
return the abandoned match's stacks, rate nobody, and record the hands really
dealt. Chips must still balance, stacks back and entry fees kept. Then walk
[RUNBOOK.md](RUNBOOK.md) and fix anything now untrue.

"Chips must still balance" is a command, not a judgement call. Run it before the
restart and again after:

```bash
railway ssh -s pokertunity -- sh -c 'cd /app && pnpm -s ledger:check'
```

It checks, in one read-only transaction:

- every cached balance against its ledger;
- that every ledger entry continues from the one before;
- that no balance is negative and no stacks sit on a closed match;
- that buy-ins and cash-outs cancel once live stacks are counted;
- that every chip in the system came in as a grant, a deposit or an adjustment.

It exits non-zero on any failure, and a one-chip discrepancy is enough to trip it.

## Sequencing

All four scopes start on day one. There are two handoffs, and both are late.

```mermaid
flowchart LR
  A1[A1 Fund wallets<br/>faucet wait] --> A2[A2 Deploy vault]
  A2 --> A4[A4 Real deposit]
  A2 -.vault address.-> D2[D2 Env vars]
  A4 -.pair up.-> C4[C4 Cashier buy]
  B1[B1 Rate limits] --> B3[B3 Measure ceiling]
  B3 --> B2[B2 Set the cap]
  D1[D1 Railway] --> D2
  D2 --> D6[D6 Incident drill]
  C1[C1 Sign-in] --> C3[C3 Owner journey]
```

Solid arrows are hard blocks, dotted arrows are handoffs between scopes.

Until A2 lands, Scope D deploys with empty vault addresses. That is a supported
state: a chain can be enabled before its vault exists, and the cashier says so and
refuses to sell there. Scope C should test that refusal deliberately, because it
is a real user-facing path.

## The launch gate

One person signs this off, and not a scope owner: someone reading their work.

- [ ] A vault is deployed on at least the default chain, and its address is set
      in production
- [ ] A real deposit has credited real chips, once, and a replay credited nothing
- [ ] One agent has an ERC-8004 identity and reputation record on every chain
- [x] The read routes are rate limited, `axes` above all
- [x] Spectators are capped per match, at a number measured rather than chosen
- [ ] A human has signed in with a wallet and played a match through to a rating
- [ ] A signed-out viewer sees no hole cards on a live match, verified by eye
- [ ] The four gates are green on `main` in CI
- [ ] Production secrets are fresh, stored in a manager, and the web service
      holds no on-chain key
- [ ] `/api/health` is alerting on `ok`, `dealing`, `unsettled` and `idleSeconds`
- [ ] A restart under load has been rehearsed and the ledger still balanced
- [ ] The hand cap on the page matches the hand cap in the engine

Nice to have and not blocking: contracts verified on the explorers that support
it, vaults on all three chains. The esbuild advisory is closed.

### Irreversible once shipped

1. **The vault owner key.** It can sweep the float and pause deposits, and
   nothing else. On testnet a throwaway key is fine; reusing it is not.
2. **Published ratings.** An attestation is a public claim and the registry is
   append-only: a later one supersedes an earlier one rather than erasing it.

### Limits you are choosing to launch with

Not bugs. Written down so nobody rediscovers them as surprises.

- **One process deals.** An advisory lock elects a single dealer and every other
  instance serves pages. That scales reads, not hands.
- **One balance across every chain.** Right for testnet tokens with no market
  against each other. Real value would need the balance, and the peg, per chain.
- **No agent versioning.** An owner can rewrite their agent between matches, so a
  rating describes something that may no longer exist.
- **Agents hold no keypair.** They authenticate with a bearer token issued from
  their owner's session, which is why ERC-8004 identity is an operator action.
