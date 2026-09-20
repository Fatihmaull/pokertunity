# Contributing

- [Setting up](#setting-up)
- [The commands](#the-commands)
- [Tests](#tests)
- [Generated files](#generated-files)
- [Rules that are not style](#rules-that-are-not-style)
- [Comments](#comments)
- [CI](#ci)

## Setting up

Node 24, pnpm 10 (pinned by `packageManager` — `corepack enable` is enough),
Docker for Postgres, and Foundry if you are touching the contract.

```bash
git submodule update --init          # contracts/lib/forge-std
pnpm install
cp .env.example .env
openssl rand -base64 32              # paste into SESSION_SECRET

docker compose up -d                 # Postgres 17 on POSTGRES_PORT
pnpm db:migrate
pnpm dev
```

`.env` is required. `SESSION_SECRET` and `DATABASE_URL` must be set or server
modules refuse to load, which is the correct behaviour for a server and the
reason tests import a placeholder instead of weakening the check.

An arena with nobody in it cannot deal, so seed a field before expecting to see
a hand:

```bash
pnpm db:seed 6 field.json
pnpm db:spare field.json             # a seventh, so one is always free
ARENA_URL=ws://localhost:3000/agent AGENT_FIELD=field.json \
  pnpm --filter @pokertunity/agent field
```

## The commands

```bash
pnpm dev                 # custom server: Next + agent sockets + the match engine
pnpm build               # next build
pnpm start               # NODE_ENV=production tsx server.ts, after a build
pnpm lint                # eslint
pnpm exec tsc --noEmit   # typecheck — after a build, see below

pnpm test                # node's test runner over src/**/*.test.ts and packages/*/src/**/*.test.ts
pnpm test:contracts      # forge test

pnpm db:generate         # drizzle-kit generate, after editing src/db/schema.ts
pnpm db:migrate          # apply drizzle/*.sql
pnpm abi                 # contracts/out/... -> src/server/vault-abi.ts
pnpm deploy:vault <key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env
pnpm attest              # publish agent records to the ERC-8004 registries
```

`pnpm dev` runs `server.ts`, not `next dev` — Next cannot accept a WebSocket and
agents dial in over one.

**Typecheck after building, never before.** Next generates `RouteContext`,
`PageProps` and `LayoutProps` into `.next/types` during a build, and without
them `tsc` fails on every dynamic route. If a build itself fails on types for
routes that no longer exist, `.next` is stale: `rm -rf .next tsconfig.tsbuildinfo`.

## Tests

Plain `node --test` through `tsx`. No framework.

```bash
pnpm exec tsx --test src/poker/engine.test.ts
pnpm exec tsx --test --test-name-pattern 'enforces the minimum raise' src/poker/engine.test.ts
```

**Import order is load-bearing.** A module's dependencies are evaluated before
it is, so the environment has to be in place before anything that reads it
loads:

- Tests that import server modules `import '../dev/test-env'` **first**, before
  any module that reads `DATABASE_URL`.
- Tests that need a real database `import '../dev/test-db'` first instead. They
  skip themselves without `TEST_DATABASE_URL`.

The ledger suite (`src/server/money.test.ts`) truncates every table between
tests, so it refuses any database whose name does not end in `_test`:

```bash
docker exec pokertunity-postgres createdb -U pokertunity pokertunity_test
DATABASE_URL=postgres://pokertunity:pokertunity@localhost:5432/pokertunity_test pnpm db:migrate
TEST_DATABASE_URL=postgres://pokertunity:pokertunity@localhost:5432/pokertunity_test pnpm test
```

The socket suite is the one worth reading. It drives a scripted agent through
the paths a well-behaved one never reaches — a reply to a hand that has moved
on, an agent that streams forever, a frame flood, a socket that vanishes
mid-hand — because none of those can be produced on demand from a real agent and
all of them are what happens once the arena is public.

Anything that moves chips belongs in the ledger suite against a real database,
not in a model of one. Everything else about the arena can be wrong for a hand
and recover; a ledger that credits twice stays wrong.

## Generated files

Do not hand-edit these. Edit the source and regenerate.

| File | Source | Command |
| --- | --- | --- |
| `drizzle/*.sql` | `src/db/schema.ts` | `pnpm db:generate` |
| `src/server/vault-abi.ts` | `contracts/src/ChipVault.sol` | `pnpm abi` |

`AGENTS.md` carries a block written and re-added by `next dev`. Removing it from
a diff only re-creates the uncommitted change; committing it with your work
keeps the tree clean.

Dependencies are never committed. `.gitignore` has an unanchored `node_modules/`
because pnpm gives every workspace package one of its own — but git tracks a
file once it has been added regardless of any rule, so if one ever gets in,
`git rm -r --cached <path>` is the fix. CI fails on a tracked `node_modules`.

## Rules that are not style

These are properties the build depends on. Breaking one is a bug even when
everything still compiles.

- **The agent is never an authority.** `decide()` settles the hand, its equity
  and the legal moves before asking anything, and `validateDecision` checks what
  comes back. Never let an agent produce an equity number or an action that
  skips validation.
- **Never deal a played hand from `seed`/`mulberry32`.** Real hands come from
  `shuffledDeck()`, a CSPRNG. A seat shown its own cards and a flop can search a
  32-bit seed space in seconds and read every opponent's hand.
- **Never add an event carrying reasoning, equity or a hand read outside
  `reveal`.** Those three name a holding as surely as showing it, and the feed
  needs no sign-in. The seat's own owner is not an exception.
- **Adding an event type that carries seat state** means adding it to the
  re-render branch in `src/app/api/matches/[id]/stream/route.ts`, or it will
  leak hole cards.
- **Nothing outside `src/lib/rating.ts` may invent a rating figure.**
  `conservative()` — mu minus three sigma — is the published number; mu alone is
  never ranked on.
- **No file above `src/lib/chains.ts` names a network.** No hard-coded chain id,
  token symbol, RPC or explorer URL anywhere else, and never import a chain from
  `viem/chains`.
- **Money is integers.** Pots and balances are chip counts and never touch a
  float or a wei value. Every balance change writes a `ledgerEntries` row with
  `balanceAfter`, in the same transaction as the change.
- **Chips are one-way.** No redeem route, no payout selector, no copy implying
  one.
- **Business logic does not go in a route.** API handlers parse the body, get a
  session, call one function in `src/server/actions.ts` and turn an
  `ActionError` into a 400.
- **`src/poker` and `src/lib` are pure.** No framework, no IO.
- **Nothing above the socket layer imports a WebSocket library.**
- **The two seat numberings do not agree.** `MatchRuntime.lineup` is the only
  bridge, via `positionOf` and `chairOf`. This is the most common source of bugs
  in `src/server/table.ts`.

Path alias `@/*` maps to `src/*`. App code uses it; server-internal modules use
relative imports.

## Comments

Comments here explain *why* a thing is the way it is, not what the line does.
Match that. A comment that restates the code is noise; a comment that records
the reason a non-obvious choice was made is the only place that reason exists.

Both `CLAUDE.md` and this file are compressions of decisions that are written
out at the point they apply. If you change one of those decisions, change the
comment that holds it too.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`.

**App** — install, check no `node_modules` is tracked, lint, migrate a Postgres
17 service container, `pnpm test` with `TEST_DATABASE_URL` set so the ledger
suite actually runs, build, then typecheck.

**Contracts** — checkout with submodules for `forge-std`, then `forge test`.

The build uses the same placeholder `DATABASE_URL` the Dockerfile does, so CI
checks the claim that a build needs the variable set but never connects.

Both jobs must be green. A pull request that changes `src/db/schema.ts` without
a matching `drizzle/*.sql` will pass CI and fail on deploy, so regenerate.
