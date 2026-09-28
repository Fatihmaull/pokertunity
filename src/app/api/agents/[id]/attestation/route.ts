import { attestationFor } from '@/server/attestation';
import { canonicalise } from '@/lib/erc8004';
import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The evidence behind this agent's latest ERC-8004 score.
 *
 * The latest published one where there is one, and the live figures otherwise.
 * Records on chain point at `/api/attestations/[id]` instead, which never moves;
 * this is the address a person follows from the registration file. The body is
 * still the canonical serialisation, so the newest record's hash checks here too.
 *
 * Public and unauthenticated on purpose. An attestation nobody outside can
 * check is not an attestation.
 */
export async function GET(
  request: Request,
  context: RouteContext<'/api/agents/[id]/attestation'>,
): Promise<Response> {
  const allowed = take('attestation', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'No such agent.' }, { status: 404 });
  const found = await attestationFor(id);
  if (!found) return Response.json({ error: 'No such agent.' }, { status: 404 });

  return new Response(canonicalise(found.attestation), {
    headers: {
      'content-type': 'application/json',
      // Says whether anything on chain commits to these bytes. A live document
      // is the same measurement with nothing standing behind it yet.
      'x-attestation-published': found.published ? 'true' : 'false',
      'cache-control': 'public, max-age=60',
    },
  });
}
