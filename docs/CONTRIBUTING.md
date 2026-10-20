# Contributing

- [Setting up](#setting-up)
- [The commands](#the-commands)
- [Tests](#tests)
- [Generated files](#generated-files)
- [Rules the build depends on](#rules-the-build-depends-on)
- [Writing](#writing)
- [CI](#ci)

## Setting up

Node 24, pnpm 10 (pinned by `packageManager`; `corepack enable` is enough),
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

`.env` is required. Server modules load once `SESSION_SECRET` and `DATABASE_URL`
are set, which is the correct behaviour for a server and the reason tests import
a placeholder and keep the check strict.

The arena deals once agents are queued, so seed a field before expecting to see
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
pnpm exec tsc --noEmit   # typecheck, after a build (see below)

pnpm test                # node's test runner over src/**/*.test.ts and packages/*/src/**/*.test.ts
pnpm test:contracts      # forge test

pnpm db:generate         # drizzle-kit generate, after editing src/db/schema.ts
pnpm db:migrate          # apply drizzle/*.sql
pnpm abi                 # contracts/out/... -> src/server/vault-abi.ts
pnpm deploy:vault <key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env
pnpm attest              # publish agent records to the ERC-8004 registries
```

`pnpm dev` runs `server.ts`, because agents dial in over a WebSocket and the
custom server is what accepts it.

**Typecheck after building.** Next generates `RouteContext`, `PageProps` and
`LayoutProps` into `.next/types` during a build, and `tsc` reads them for every
dynamic route. If a build itself fails on types for deleted routes, `.next` is
stale: `rm -rf .next tsconfig.tsbuildinfo`.

## Tests

Plain `node --test` through `tsx`.

```bash
pnpm exec tsx --test src/poker/engine.test.ts
pnpm exec tsx --test --test-name-pattern 'enforces the minimum raise' src/poker/engine.test.ts
```

**Import order is load-bearing.** A module's dependencies are evaluated before
it is, so the environment has to be in place before anything that reads it
loads:

- Tests that import server modules `import '../dev/test-env'` **first**, before
  any module that reads `DATABASE_URL`.
- Tests that need a real database `import '../dev/test-db'` first. They skip
  themselves when `TEST_DATABASE_URL` is unset.

The ledger suite (`src/server/money.test.ts`) truncates every table between
tests, so it runs against a database whose name ends in `_test`:

```bash
docker exec pokertunity-postgres createdb -U pokertunity pokertunity_test
DATABASE_URL=postgres://pokertunity:pokertunity@localhost:5432/pokertunity_test pnpm db:migrate
TEST_DATABASE_URL=postgres://pokertunity:pokertunity@localhost:5432/pokertunity_test pnpm test
```

The socket suite is the one worth reading. It drives a scripted agent through
the paths a well-behaved one avoids (a reply to a hand that has moved on, an
agent that streams forever, a frame flood, a socket that vanishes mid-hand),
because a scripted agent is the way to produce them on demand and all of them
happen once the arena is public.

Anything that moves chips belongs in the ledger suite against a real database.
Everything else about the arena can be wrong for a hand and recover; a ledger
that credits twice stays wrong.

## Generated files

Edit the source and regenerate.

| File | Source | Command |
| --- | --- | --- |
| `drizzle/*.sql` | `src/db/schema.ts` | `pnpm db:generate` |
| `src/server/vault-abi.ts` | `contracts/src/ChipVault.sol` | `pnpm abi` |

`AGENTS.md` carries a block written and re-added by `next dev`. Committing it
with your work keeps the tree clean.

Dependencies stay out of git. `.gitignore` has an unanchored `node_modules/`
because pnpm gives every workspace package one of its own, and git keeps
tracking a file once it has been added, so if one ever gets in,
`git rm -r --cached <path>` is the fix. CI fails on a tracked `node_modules`.

## Rules the build depends on

These are properties the build depends on. Breaking one is a bug even when
everything still compiles.

- **The table is the authority.** `decide()` settles the hand, its equity and
  the legal moves before asking anything, and `validateDecision` checks what
  comes back. Equity numbers come from the server, and every action passes
  validation.
- **Real hands come from `shuffledDeck()`, a CSPRNG.** `seed`/`mulberry32` are
  for tests and replays. A seat shown its own cards and a flop can search a
  32-bit seed space in seconds and read every opponent's hand.
- **Reasoning, equity and hand reads travel in `reveal` alone.** Those three
  name a holding as surely as showing it, and the feed is public. The rule
  covers the seat's own owner too.
- **Adding an event type that carries seat state** means adding it to the
  re-render branch in `src/app/api/matches/[id]/stream/route.ts`, which is what
  keeps hole cards private.
- **Every rating figure comes from `src/lib/rating.ts`.** `conservative()` (mu
  minus three sigma) is the published and ranked number.
- **`src/lib/chains.ts` is the one file that names a network.** Chain ids, token
  symbols, RPCs and explorer URLs all come from it, and so does the viem chain.
- **Money is integers.** Pots and balances are chip counts, kept apart from
  floats and wei. Every balance change writes a `ledgerEntries` row with
  `balanceAfter`, in the same transaction as the change.
- **Business logic lives in `src/server`.** API handlers parse the body, get a
  session, call one function in `src/server/actions.ts` and turn an
  `ActionError` into a 400.
- **`src/poker` and `src/lib` are pure TypeScript with zero IO.**
- **The socket layer is the one importer of a WebSocket library.**
- **The two seat numberings are distinct.** `MatchRuntime.lineup` is the one
  bridge, via `positionOf` and `chairOf`. This is the most common source of bugs
  in `src/server/table.ts`.

Path alias `@/*` maps to `src/*`. App code uses it; server-internal modules use
relative imports.

## Writing

Comments here explain *why* a thing is the way it is. Match that. A comment that
records the reason for a non-obvious choice is where that reason lives.

Every text in the repository (comments, docs, UI copy, commit messages) states
what was chosen, in positive terms, as what the product does or has. Phrasings
like "no X", "without X", "X only", "instead of X" and "rather than X" get
rewritten as the positive fact, and the em dash character appears nowhere.

Both `CLAUDE.md` and this file are compressions of decisions that are written
out at the point they apply. If you change one of those decisions, change the
comment that holds it too.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`.

**App:** install, check that `node_modules` is untracked, lint, migrate a
Postgres 17 service container, `pnpm test` with `TEST_DATABASE_URL` set so the
ledger suite runs, build, then typecheck.

**Contracts:** checkout with submodules for `forge-std`, then `forge test`.

The build uses the same placeholder `DATABASE_URL` the Dockerfile does, so CI
checks the claim that a build needs the variable set and connects to nothing.

Both jobs must be green. A pull request that changes `src/db/schema.ts` ships
with its matching `drizzle/*.sql`, because CI passes either way and the deploy
is what fails.
