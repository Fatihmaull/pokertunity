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
| Four gates | lint clean, 185/185 tests, build ok, `tsc` clean, green on `main` in CI |
| Contracts | 12/12 Foundry tests, including `test_NoPayoutPathExists` |
| Full match | Six-handed, dealt to the hand cap, settled, ratings rewritten |
| Chip conservation | 6 × 2,000 in, exactly 12,000 out |
| Ledger integrity | No break in `balance_after`, no cache drift, the entry fee the only sink |
| Redaction | Anonymous viewer sees `hole: null` and a sealed brain |
| Engine lock | A second instance serves pages and refuses to deal |
| Graceful shutdown | Every agent got a stated reason and reconnected with backoff |
| Crash recovery | Dealer killed mid-match: stacks returned, hand count kept, nobody rated |
| Sign-in | Real signature over SIWE, session issued, agent registered, token connected |
| Socket refusals | Bad token 4001, wrong version 4002, each with a sentence |

### Never exercised

- **The on-chain deposit path.** No vault is deployed anywhere. `observeDeposit`,
  confirmation counting, the intent-versus-chain check and the real `ChipVault`
  have only run against a stubbed RPC. This is Scope A and it is the blocker.
- **ERC-8004 attestation.** `pnpm attest` has never run.
- **Load and concurrency.** One table of six agents is not a measurement.
- **The browser.** Only status codes and JSON were checked. No wallet, no eyes.

### Known, not yet fixed

Capacity and abuse surfaces rather than bugs. All belong to Scope B.

1. `/api/agents/[id]/axes` is public, unauthenticated, and scans up to 5,000 rows
   of `results` per request.
2. No cap on concurrent SSE subscribers. Redaction re-renders per viewer per
   event, so the cost is O(N) on the one process that must keep dealing.
3. `/api/leaderboard` and `/api/hands/latest` are heavy aggregate reads with no
   limit.
4. `esbuild` moderate advisory via `drizzle-kit`: a devDependency path, so
   production is unaffected, and no patch is available.

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

Nothing here has ever accepted a real deposit. Make that sentence false, and
prove the one-way property on bytecode that is actually deployed.

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

### A5. Prove one-way on deployed bytecode

`test_NoPayoutPathExists` proves this in the suite. Prove it again live: from the
owner address, call the selector the removed payout function used to answer on,
and send a bare transfer to the vault.

**Done when:** both revert on the live contract, with transaction hashes to show.

### A6. ERC-8004 attestation (second phase, not launch-blocking)

Only after A1–A5. Needs the three registry addresses per chain,
`ATTESTOR_PRIVATE_KEY`, and a `PUBLIC_BASE_URL` reachable from outside.
Establishing which registries are canonical is a judgement call, not a lookup;
write down why you chose them.

The running server never touches a registry. Attestation is a separate command
with its own key. Keep it that way.

> Do not add a redeem route, a payout selector, or copy that implies one. Chips
> being one-way is a property of deployed bytecode, and once the vault holds
> deposits that decision cannot be revisited.

## Scope B — Hardening and capacity

Every mutating and authentication route is rate limited. No read route is, and
there is no global middleware. Read `src/server/rate-limit.ts` first: the pattern
you need exists and is already tested.

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
6,120 chips.

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

1. Sign in; you have 6,120 chips
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
9. Rotating the token refuses the old one and disconnects the running agent with
   a stated reason
10. The ninth agent is refused: "One account can run 8 agents."

### C4. Cashier

The daily claim pays once and refuses the second ask the same day. Before Scope A
deploys a vault, buying must be refused by name: "Chips cannot be bought on BNB
Smart Chain Testnet yet." Confirm there is no withdraw, redeem or cash-out
control anywhere, and no copy implying one. After Scope A finishes, pair with
them on the real deposit.

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

`railway.json` already names the Dockerfile builder, runs `pnpm db:migrate` before
the new instance takes traffic, and pins one replica. Do not raise `numReplicas`:
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

### D6. Rehearse an incident

On the deployed instance, with agents connected: restart the service mid-match.
Agents must get a stated reason and reconnect on their own; the replacement must
return the abandoned match's stacks, rate nobody, and record the hands really
dealt. Chips must still balance, stacks back and entry fees kept. Then walk
[RUNBOOK.md](RUNBOOK.md) and fix anything now untrue.

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
- [ ] One-way is proven on deployed bytecode
- [ ] The read routes are rate limited, `axes` above all
- [ ] Spectators are capped per match, at a number measured rather than chosen
- [ ] A human has signed in with a wallet and played a match through to a rating
- [ ] A signed-out viewer sees no hole cards on a live match, verified by eye
- [ ] The four gates are green on `main` in CI
- [ ] Production secrets are fresh, stored in a manager, and the web service
      holds no on-chain key
- [ ] `/api/health` is alerting on `ok`, `dealing`, `unsettled` and `idleSeconds`
- [ ] A restart under load has been rehearsed and the ledger still balanced
- [ ] The hand cap on the page matches the hand cap in the engine

Nice to have and not blocking: contracts verified on the explorers that support
it, an ERC-8004 record published for one agent, vaults on all three chains, the
esbuild advisory closed rather than accepted.

### Irreversible once shipped

1. **Chips are one-way, in bytecode.** The deployed vault has no function that
   pays a player and no operator path. Once it holds deposits that is settled.
2. **The vault owner key.** It can sweep the float and pause deposits, and
   nothing else. On testnet a throwaway key is fine; reusing it is not.
3. **Published ratings.** An attestation is a public claim and the registry is
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
