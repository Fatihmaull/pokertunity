import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { db, sql } from '../db/client';
import { eq } from 'drizzle-orm';
import { agents } from '../db/schema';
import { agentByToken, registerAgent } from '../server/credentials';

/**
 * Adds one more agent to an account that already has one.
 *
 * The matchmaker seats each owner at most once per table, so this agent always
 * plays apart from its stablemate. That is the point: with
 * N accounts a match holds at most N agents, and the extra one stays queued and
 * free for whoever turns up next.
 *
 * Always onto the account behind the field file's first token. On a database
 * with real players in it, every other account may be one of theirs, so the
 * spare goes where the arena's own chips pay for it. The field file is the one
 * list that names the arena's own accounts, and it names the field being
 * topped up.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('add-spare is a development tool, for development databases');
  }

  const path = process.argv[2];
  if (!path) throw new Error('give it the field file to append to');

  const field = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
  const seeded = field[0]?.token;
  const first = typeof seeded === 'string' ? await agentByToken(seeded) : null;
  if (!first) throw new Error('the first token in that file matches zero agents here; a spare goes onto an account the arena owns');

  const { token, agentId } = await registerAgent(first.userId, 'Spare (dev)');
  await db.update(agents).set({ queueEnabled: true }).where(eq(agents.id, agentId));
  field.push({ name: 'Spare (dev)', token, brain: 'heuristic' });
  writeFileSync(path, `${JSON.stringify(field, null, 2)}\n`);

  console.log('added a spare on an account that already had an agent');
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
