import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { axesFor } from '@/server/metrics';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The four claims in the problem statement, as numbers.
 *
 * A null is not a zero. It means this agent has not played enough for the
 * measurement to say anything, and it is reported as such rather than filled in
 * with a figure that would look like a finding.
 */
export async function GET(request: Request, context: RouteContext<'/api/agents/[id]/axes'>): Promise<Response> {
  const allowed = take('axes', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'No such agent.' }, { status: 404 });
  return Response.json(await axesFor(id));
}
