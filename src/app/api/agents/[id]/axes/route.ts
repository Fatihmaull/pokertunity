import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { axesFor } from '@/server/metrics';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The four claims in the problem statement, as numbers.
 *
 * A null is distinct from a zero. It means this agent is still short of the
 * sample the measurement needs, and it is reported as exactly that.
 */
export async function GET(request: Request, context: RouteContext<'/api/agents/[id]/axes'>): Promise<Response> {
  const allowed = take('axes', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'Unknown agent.' }, { status: 404 });
  return Response.json(await axesFor(id));
}
