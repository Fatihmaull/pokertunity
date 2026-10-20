import { desc, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { hands, seats } from '@/db/schema';
import { dealing } from '@/server/engine-lock';
import { unsettledMatches } from '@/server/matchmaker';
import { allMatches } from '@/server/registry';

/**
 * Whether this deployment is actually running a poker room.
 *
 * Answering requests and dealing hands are separate jobs that fail separately:
 * the engine can be stalled, or this can be the second instance that correctly
 * serves pages alone. So the answer says which process this is and when a hand
 * was last finished.
 *
 * Always fresh, so every answer describes the present moment.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const engine = dealing();

  try {
    const [latest] = await db
      .select({ finishedAt: hands.endedAt })
      .from(hands)
      .where(isNotNull(hands.endedAt))
      .orderBy(desc(hands.endedAt))
      .limit(1);

    const [occupied] = await db.select({ count: raw<number>`count(*)::int` }).from(seats);

    const lastHandAt = latest?.finishedAt ?? null;
    const idleSeconds = lastHandAt === null ? null : Math.round((Date.now() - lastHandAt.getTime()) / 1000);

    return Response.json({
      // A page-serving instance is healthy while idle at the table. The process
      // holding the engine is the one judged on whether hands are being played.
      ok: true,
      dealing: engine,
      matches: engine ? allMatches().length : 0,
      // Finished matches whose chips are still on the way back. Anything above
      // zero for longer than a tick or two is stacks stuck on a closed table.
      unsettled: engine ? unsettledMatches() : 0,
      seated: occupied?.count ?? 0,
      lastHandAt: lastHandAt?.toISOString() ?? null,
      idleSeconds,
    });
  } catch (error) {
    // Everything depends on the database, so reaching it is what makes this
    // instance healthy.
    return Response.json(
      { ok: false, dealing: engine, error: error instanceof Error ? error.message : 'database unreachable' },
      { status: 503 },
    );
  }
}
