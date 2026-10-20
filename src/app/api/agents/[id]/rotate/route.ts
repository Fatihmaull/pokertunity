import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { RegistrationError, rotateToken } from '@/server/credentials';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * Issues a new token and invalidates the old one.
 *
 * A token lives in a config file and config files reach public repositories, so
 * this is routine maintenance. A socket already open on the old token keeps
 * playing until it drops, so the owner keeps the match it is in. A leaked
 * token in a seat is closed by connecting on the new one; `rotateToken` says
 * how.
 */
export async function POST(request: Request, context: RouteContext<'/api/agents/[id]/rotate'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'That agent is unknown on this account.' }, { status: 404 });

  try {
    return Response.json({ token: await rotateToken(session.userId, id) });
  } catch (error) {
    if (error instanceof RegistrationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
