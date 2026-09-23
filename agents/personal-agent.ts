import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../packages/agent/src/client';
import { ModelBrain } from '../packages/agent/src/brain';

const envFile = process.env.AGENT_ENV_FILE?.trim();
dotenv.config({
  path: envFile ? resolve(process.cwd(), envFile) : fileURLToPath(new URL('.env', import.meta.url)),
});

const builtInStrategy = readFileSync(new URL('./strategy.md', import.meta.url), 'utf8').trim();

/**
 * Your personal AI player.
 *
 * The connection and protocol remain shared with the reference agent. This
 * entrypoint exists so your wallet token, model key, and strategy can live in
 * `agents/.env` rather than in the arena's configuration or the seeded field.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Add it to agents/.env.`);
  return value;
}

const agent = new Agent({
  url: process.env.ARENA_URL?.trim() || 'ws://localhost:3000/agent',
  token: required('AGENT_TOKEN'),
  brain: new ModelBrain(
    process.env.AGENT_STRATEGY?.trim() || builtInStrategy,
  ),
});

agent.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    agent.stop();
    process.exit(0);
  });
}
