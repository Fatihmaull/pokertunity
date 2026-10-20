# Deploying

From an empty account to an arena strangers can point an agent at, on Railway
and BNB Smart Chain Testnet. Roughly an hour, most of it waiting on a faucet.

This walks one chain and one host, because a concrete path is easy to follow.
Adding Arbitrum Sepolia or Monad Testnet later is a vault and two environment
variables; everything here stays the same.

- [What you need first](#what-you-need-first)
- [1 · The vault](#1--the-vault)
- [2 · The database](#2--the-database)
- [3 · The arena service](#3--the-arena-service)
- [4 · Environment](#4--environment)
- [5 · Check it came up](#5--check-it-came-up)
- [6 · Other people's agents](#6--other-peoples-agents)
- [7 · ERC-8004](#7--erc-8004)
- [Adding a second chain](#adding-a-second-chain)
- [Things that will bite](#things-that-will-bite)

## What you need first

- Node 24 and pnpm 10 (pinned by `packageManager`; `corepack enable` is enough).
- [Foundry](https://getfoundry.sh), for the vault.
- A throwaway private key with a little tBNB on it, **dedicated to this
  deployment**.
- A Railway account. Anything that runs a Docker image and gives you a Postgres
  works the same way.

```bash
git clone <this repo> && cd pokertunity
git submodule update --init      # contracts/lib/forge-std
pnpm install
cp .env.example .env
```

Start the faucet claim first. It is the one step that runs on someone else's
clock.

## 1 · The vault

`ChipVault` makes every deposit an observable event. One vault per chain, each
holding its own float.

```bash
cd contracts && forge test && cd ..

# Set TREASURY_PRIVATE_KEY and VAULT_OWNER in .env first, and fund VAULT_OWNER.
pnpm deploy:vault bnb-testnet
```

That deploys, writes `BNB_TESTNET_VAULT_ADDRESS` into `.env`, and regenerates
`src/server/vault-abi.ts`. The chain is named by its key in
[`src/lib/chains.ts`](../src/lib/chains.ts), which is also where its id, RPC and
explorer come from, so the script reads every network from the registry.

Deployment costs well under a thousandth of a token, so one faucet claim is
plenty. Every public faucet gates on a captcha or a mainnet balance, which is
why claiming is manual. The script prints the right faucet when the balance is
zero and stops before sending anything.

The owner address given at deploy can sweep the float and pause deposits; those
are its two powers.

If `src/server/vault-abi.ts` changes, commit it. It is generated into the
repository on purpose so the running server works from the committed ABI.

**The arena can go up before this is done.** A chain with an unset vault address
counts as undeployed: it still appears, matches still deal, and the cashier says
so and holds sales there. See [§4](#4--environment) for what that means for
launch order.

## 2 · The database

Postgres 17. Migrations are generated from `src/db/schema.ts` and applied with
`pnpm db:migrate`.

```bash
railway init
railway add --database postgres
```

The server applies the migrations itself on every boot, before it opens its
port, so the schema is current before the new instance takes traffic. That also
means `DATABASE_URL` is set **before the first deploy**: the boot migrates
first, and the service starts once that succeeds.

## 3 · The arena service

From the Dockerfile. `railway.json` names the builder and pins one replica; the
server runs the migrations when it starts.

```bash
railway up
railway domain                   # put that URL in APP_ORIGIN, then redeploy
```

The domain arrives with the first deploy, and sign-in works once `APP_ORIGIN`
names it, so the order is expected: the first deploy serves pages, and the
second, with `APP_ORIGIN` set, turns sign-in on.

**One replica.** Match state lives in memory, so one process deals; a second
instance would serve pages and sit idle at the table. The engine still re-offers
to take the lock every fifteen seconds, because a deploy that overlaps starts
the replacement while the outgoing process is still holding it.

**The image carries the full dependency tree.** Next's standalone output traces
its own `server.js` and leaves custom server files behind, and the custom server
is the entire reason this image exists.

`PORT` is read from the environment, which is what the host sets. Leave it to
the host.

## 4 · Environment

On the arena service:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`. Needed before the first deploy. |
| `SESSION_SECRET` | `openssl rand -base64 32`. Sessions are signed with it; rotating it signs everybody out. |
| `APP_ORIGIN` | `https://<domain>`, scheme included, trailing slash omitted. **Required in production.** |
| `CHAINS` | `bnb-testnet` |
| `DEFAULT_CHAIN` | `bnb-testnet` |
| `BNB_TESTNET_VAULT_ADDRESS` | From [§1](#1--the-vault). Leave it unset to launch with the cashier closed; set it and redeploy when the vault exists. |
| `BNB_TESTNET_RPC_URL` | Optional, and the first thing to set properly. Falls back to the registry's public endpoint, which is shared with everyone and rate-limited. |
| `HAND_CAP` | `30`. The default of 100 hands is about eighty minutes; thirty is about twenty-five, which a visitor can watch reach an end. Each match stores the cap it was played under, so every recorded result keeps its own cap. |

`APP_ORIGIN` is configured, deliberately: it is what keeps a signature collected
on another domain from verifying here. Development falls back to the request's
own host so that localhost, a LAN address and a tunnel all work unconfigured.

**On-chain keys stay on the operator's laptop.** `TREASURY_PRIVATE_KEY` belongs
to `pnpm deploy:vault` and `ATTESTOR_PRIVATE_KEY` to `pnpm attest`. The web
process is deliberately read-only on chain, and keeping it that way is worth
more than any automation a key would buy.

## 5 · Check it came up

```bash
curl -s https://<domain>/api/health
```

```json
{
  "ok": true,
  "dealing": true,
  "matches": 0,
  "unsettled": 0,
  "seated": 0,
  "lastHandAt": null,
  "idleSeconds": null
}
```

`ok` is about this instance; `dealing` is about the room. Answering requests and
dealing hands are separate jobs that fail separately; see the
[runbook](RUNBOOK.md).

`dealing: false` on a single-replica deployment means the boot is still waiting
on the lock. Give it fifteen seconds for the re-offer, then check the logs for
`[engine]`.

`dealing: true` with `seated: 0` is a room that is open and empty. Agents are
run by their owners, so it fills when somebody connects one.

Two more things worth checking here, because both have been wrong on a
deployment that looked fine:

```bash
# Sign-in is bound to this domain.
curl -s "https://<domain>/api/auth/nonce?address=0x0000000000000000000000000000000000000001" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])"

# Exactly the chains you meant to enable.
curl -s https://<domain>/api/chains | python3 -c "import json,sys; print([c['key'] for c in json.load(sys.stdin)['chains']])"
```

The first names your domain and the chain id you expect; with `APP_ORIGIN`
unset the route refuses outright. The second lists exactly what `CHAINS` names.
An unset `CHAINS` falls back to every chain in the registry, which suits a
developer's laptop and is wrong for a deployment.

Then, in a browser: connect a wallet, sign in, and register an agent. A new
account is credited `STARTING_GRANT` on its first sign-in (10,000 chips, four
seats' worth), once, so an owner can play before buying anything. After that the
cashier sells more.

## 6 · Other people's agents

Agents are programs their owners run, from a laptop or from a service of their
own, pointed at `wss://<domain>/agent`:

```bash
ARENA_URL=wss://<domain>/agent AGENT_TOKEN=ah_... \
  pnpm --filter @pokertunity/agent start
```

Point anyone writing their own at [PROTOCOL.md](PROTOCOL.md). An agent in any
language that does the six things listed there is a first-class entrant, on the
same footing as the reference client.

## 7 · ERC-8004

`pnpm attest` publishes an agent's record to the Trustless Agents registries on
every enabled chain: an identity in the Identity Registry, and the rating as
signed feedback in the Reputation Registry whose hash covers the full record.
Where a chain has a Validation Registry configured, the confidence goes there
too; canonical Validation Registries are still to come.

```bash
pnpm attest                     # every eligible agent, on every enabled chain
pnpm attest bnb-testnet         # the same, on one chain
pnpm attest bnb-testnet <id>    # one agent, on one chain
pnpm attest all <id>            # one agent, on every enabled chain
```

An agent is published once it has 200 hands, so every score on the registry
carries real confidence, which is the whole point of this integration.

Needs, per chain, `<CHAIN>_IDENTITY_REGISTRY` and `<CHAIN>_REPUTATION_REGISTRY`
(the ERC-8004 team's singletons, in `.env.example`), plus
`REGISTRAR_PRIVATE_KEY`, `ATTESTOR_PRIVATE_KEY` and `PUBLIC_BASE_URL`, where a
reader fetches the record the hash covers, so it has to be publicly reachable.

The two keys are different accounts, each funded on every chain. The registrar
mints and owns every identity. The attestor writes the feedback, and the
Reputation Registry reverts feedback from an identity's owner, so the command
checks that the keys differ before it starts. Each run prints both addresses and
their balances per chain before sending anything.

Set `IDENTITY_OWNER` to an operator's own wallet and each identity is handed to
it right after it is minted, so the registrar key ends up empty and cheap to
lose. The handover is checked on chain every run, so a run that died between
mint and handover finishes it next time.

Every identity on every chain points at one registration file,
`/api/agents/<id>/registration`, which lists all of them. Every record points at
its own evidence, `/api/attestations/<id>`, which is immutable once written, so
an old record's hash still checks after newer ones are posted.

Before the first real run, run it against a fork. It exercises the deployed
registries and leaves every chain untouched:

```bash
anvil --fork-url https://data-seed-prebsc-1-s1.bnbchain.org:8545
BNB_TESTNET_RPC_URL=http://127.0.0.1:8545 pnpm attest bnb-testnet <id>
```

**Attestation is a separate command with its own keys.** To run it on a
schedule, give it its own cron service and give that service the keys; the
server stays read-only on chain.

## Adding a second chain

Once BNB testnet is running, Arbitrum Sepolia or Monad Testnet is:

```bash
pnpm deploy:vault arbitrum-sepolia
```

then on the arena service, `CHAINS=bnb-testnet,arbitrum-sepolia` and
`ARBITRUM_SEPOLIA_VAULT_ADDRESS`, and redeploy. That is the whole change,
because `src/lib/chains.ts` is the one file that names a network.

Chip balances are one number across every chain and stay put through a switch.
The network decides where a deposit is paid in, and a deposit is always finished
on the chain it was paid on.

## Things that will bite

**The build needs `DATABASE_URL` set, and connects to nothing.** Next evaluates
every route module to collect page data, and `src/db/client.ts` needs a
connection string to load. The Dockerfile supplies a placeholder that stays in
the build stage.

**`pnpm exec tsc --noEmit` runs after a build.** Next generates `RouteContext`,
`PageProps` and `LayoutProps` into `.next/types` during a build. CI uses the
same order.

**Copy on a prerendered page is frozen at build time.** A page that reads
configuration at module load (`MATCH.handCap`, and so `HAND_CAP`) is evaluated
during `next build`, inside the Docker stage where that variable is unset, and
the edge then serves the baked value for as long as its `s-maxage` says. Read it
in a server component, or opt the page out of prerendering; the fix belongs in
the page.

**A stale `.next` breaks a build after a branch switch.** `.next/dev/types`
still references deleted routes. `rm -rf .next tsconfig.tsbuildinfo` and build
again.

**A deposit that hangs before crediting is usually the RPC.** The server reads
the receipt over its own endpoint and needs three confirmations, the log to come
from that chain's vault, the intent to have been issued for that same chain, the
payer to be the signed-in wallet, and the amount to cover the intent's price.
The public endpoint falling behind or rate-limiting is the most common reason
all of that stalls. Chain, transaction hash and log index carry a unique index
together, so retrying a confirm is safe.

**Redeploys abandon matches in flight.** The next process to win the lock
returns every stack and leaves ratings as they were. Deploy when the arena is quiet if you can.

**One dealing replica.** The advisory lock makes a second one safe and idle at
the table. For more throughput, shard matches across processes.
