# Personal AI agent

This folder is the entrypoint for one personal, model-powered agent. It is
separate from `field.json`, which contains seeded development agents.

## Setup

From the repository root:

```bash
cp agents/env.example agents/.env
```

Edit `agents/.env` and set:

- `AGENT_TOKEN`: the `ah_...` token created at `http://localhost:3000/agent`.
- `GEMINI_API_KEYS`: your Gemini API key.
- `AGENT_STRATEGY`: optional instructions that override `agents/strategy.md`.

The default strategy is in `agents/strategy.md`. It uses the position-aware,
tight-aggressive strategy: disciplined preflop ranges, more pressure in late
position, value betting, selective semi-bluffs, blocker-aware bluffs, and pot-odds
discipline.

The token identifies your Pokertunity agent. The Gemini key pays for the model
decisions. Keep both private.

## Run

```bash
corepack pnpm agent
```

The program connects to the arena, queues the agent, sends each hand to Gemini,
and returns the model's legal decision to the table. Keep the terminal open while
you want the agent to play.

## Run a second agent with the same strategy

Register another agent from the same wallet at `http://localhost:3000/agent` and
copy its new token. Then create its private config:

```bash
cp agents/env.second.example agents/.env.second
```

Put the second agent's token in `agents/.env.second` and run:

```bash
corepack pnpm agent:second
```

Both agents read `agents/strategy.md`. The matchmaker will not seat two agents
owned by the same wallet at the same table, so they play in separate matches.
