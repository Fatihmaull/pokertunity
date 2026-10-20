import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from './client';
import { HeuristicBrain, ModelBrain, type Brain } from './brain';

/**
 * Runs several agents from one process.
 *
 * This is what keeps an arena inhabited. Two is a legal match, so the first
 * person to bring an agent needs somebody already there to play.
 *
 * One detail decides the shape of a field. The matchmaker seats each owner at
 * most once per table, so a field spread across N accounts can put at most N
 * agents in a match. Running one more agent than that leaves a spare
 * permanently free, and a stranger who connects is seated against it within
 * seconds.
 *
 * ```
 * ARENA_URL=ws://localhost:3000/agent \
 * AGENT_FIELD=./field.json \
 * pnpm --filter @pokertunity/agent field
 * ```
 *
 * Where field.json is a list of entries:
 *
 * ```json
 * [
 *   { "token": "ah_...", "brain": "model", "strategy": "Raise your pairs." },
 *   { "token": "ah_...", "brain": "heuristic" }
 * ]
 * ```
 */

interface Entry {
  token: string;
  brain?: 'model' | 'heuristic';
  strategy?: string;
}

function load(): Entry[] {
  const source = process.env.AGENT_FIELD?.trim();
  if (!source) throw new Error('AGENT_FIELD is required. Point it at a JSON file or give it JSON directly.');

  // Resolved against where the command was typed. `pnpm --filter` runs with the
  // working directory set to the package it filtered to, and a path given
  // relative to the repository root (where `db:seed` writes the field file, and
  // what every example of this command shows) belongs to where pnpm was invoked.
  // INIT_CWD is what pnpm sets to that directory; when it is unset, the plain
  // cwd is already the right answer.
  const text = source.startsWith('[')
    ? source
    : readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), source), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('AGENT_FIELD must be a non-empty list.');

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`entry ${index} must be an object`);
    const row = entry as Entry;
    if (typeof row.token !== 'string') throw new Error(`entry ${index} needs a token`);
    return row;
  });
}

function brainFor(entry: Entry): Brain {
  return entry.brain === 'model' ? new ModelBrain(entry.strategy ?? '') : new HeuristicBrain();
}

const url = process.env.ARENA_URL ?? 'ws://localhost:3000/agent';
const field = load();
const agents = field.map((entry) => new Agent({ url, token: entry.token, brain: brainFor(entry) }));

// Staggered a quarter second apart. Six sockets opening in the same
// millisecond is the one moment a reconnect storm looks exactly like an attack,
// and a field has all the time it needs.
agents.forEach((agent, index) => setTimeout(() => agent.start(), index * 250));

console.log(`[field] starting ${agents.length} agents against ${url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const agent of agents) agent.stop();
    process.exit(0);
  });
}
