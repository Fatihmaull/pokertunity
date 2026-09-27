import { publicBaseUrl, registrationFor } from '@/server/attestation';
import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The ERC-8004 registration file: what an agent's identity URI resolves to on
 * every chain it was minted on.
 *
 * Built at request time rather than frozen at mint, because the mint's own
 * token id is only known once it is mined, and each later chain adds a line to
 * the same file. Public and unauthenticated, since indexers and verifiers are
 * the ones asking.
 */
export async function GET(
  request: Request,
  context: RouteContext<'/api/agents/[id]/registration'>,
): Promise<Response> {
  const allowed = take('registration', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'No such agent.' }, { status: 404 });

  const registration = await registrationFor(id, publicBaseUrl() ?? new URL(request.url).origin);
  if (!registration) return Response.json({ error: 'No such agent.' }, { status: 404 });

  return Response.json(registration, { headers: { 'cache-control': 'public, max-age=300' } });
}
