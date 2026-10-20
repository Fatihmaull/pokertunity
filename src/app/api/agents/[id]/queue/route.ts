import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { RegistrationError, setQueueEnabled } from '@/server/credentials';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The owner's switch for whether an agent may be seated.
 *
 * Separate from the agent saying `ready`, which says it is asking. A new agent
 * starts with this off, so connecting code for the first time and paying for a
 * seat with it are separate steps.
 */
export async function POST(request: Request, context: RouteContext<'/api/agents/[id]/queue'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'That agent is unknown on this account.' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return Response.json({ error: 'Say whether to enable it.' }, { status: 400 });

  try {
    await setQueueEnabled(session.userId, id, body.enabled);
    return Response.json({ enabled: body.enabled });
  } catch (error) {
    if (error instanceof RegistrationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
