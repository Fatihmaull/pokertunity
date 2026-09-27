import { attestationById } from '@/server/attestation';
import { canonicalise } from '@/lib/erc8004';
import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * One published attestation's evidence: the document the URI on chain names.
 *
 * The body is the canonical serialisation, byte for byte what was hashed, so a
 * reader hashes what it received and compares it with the hash beside the
 * record. Never the agent's latest figures: those live at
 * `/api/agents/[id]/attestation`, and pointing an old record at them would make
 * every record but the newest fail its own check.
 */
export async function GET(request: Request, context: RouteContext<'/api/attestations/[id]'>): Promise<Response> {
  const allowed = take('attestation', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'No such attestation.' }, { status: 404 });
  const found = await attestationById(id);
  if (!found) return Response.json({ error: 'No such attestation.' }, { status: 404 });

  return new Response(canonicalise(found.attestation), {
    headers: {
      'content-type': 'application/json',
      // False while its transactions are still in flight, or if the run that
      // wrote it died before they were sent.
      'x-attestation-published': found.published ? 'true' : 'false',
      // The bytes never change once written; only the header above can.
      'cache-control': found.published ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}
