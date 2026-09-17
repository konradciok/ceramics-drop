import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { PRICING_RESOURCE_ID, loadPricingResource } from '../pricing-mapping';
import { parsePricingFields } from '../pricing-validation';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// Same currentRevision=<n> detail-string parsing as every other publication /
// save handler (Global Constraint 8/21).
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

// publish_pricing_revision raises `pricing_invalid` with
// `detail = format('invalidKeys=%s', array_to_string(v_invalid, ','))` — the
// same detail-string convention publish_collection_revision uses for
// product_ref_invalid / invalidIds=. Parsed verbatim.
function extractInvalidPricingKeys(error: { details?: string | null; message?: string }): string[] {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/invalidKeys=(.*)$/);
  if (!match) return [];
  return match[1].split(',').filter((key) => key.length > 0);
}

export const pricingPublicationPostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/pricing/{id}/publication',
  handler: async (req, _env, params, ctx) => {
    if (params.id !== PRICING_RESOURCE_ID) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
    }

    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return errorResponse('IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required.', 422, ctx.requestId);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }
    if (typeof body !== 'object' || body === null) {
      return errorResponse('VALIDATION_FAILED', 'Request body must be a JSON object.', 422, ctx.requestId);
    }
    // Contract's Revision schema is bare {expectedRevision} — no `action`
    // field (pricing, like collections, has no status states).
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'pricing:publication', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    // Swallow a release failure everywhere below so it can never replace a
    // mapped error response with a generic 500 — a failed release just leaves
    // the lease in place, and idempotency.ts's 30s LEASE_MS lets a later
    // request reclaim it (same rationale as collections-publication.ts).
    const release = async () => {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'pricing:publication', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
    };

    try {
      // Publish-time range check, run BEFORE the RPC so a bad price list comes
      // back as per-field messages the CMS form can render inline. The RPC
      // re-checks the identical ranges itself (and the column CHECK
      // constraints back both) — this pre-flight exists for the error quality,
      // not as the enforcement.
      //
      // Only meaningful when the draft the client is publishing is the one
      // that is actually current; if the revisions disagree, skip straight to
      // the RPC so the authoritative revision_conflict wins over a validation
      // complaint about a draft the client was not looking at.
      const current = await loadPricingResource(ctx.supabase);
      if (!current) {
        await release();
        return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
      }
      if (current.revision === parsed.expectedRevision) {
        const validated = parsePricingFields(current.fields);
        if (!validated.ok) {
          await release();
          return errorResponse('VALIDATION_FAILED', 'Cennik zawiera nieprawidłowe wartości.', 422, ctx.requestId, {
            fieldErrors: validated.fieldErrors,
          });
        }
      }

      const { error } = await ctx.supabase.rpc('publish_pricing_revision', {
        p_expected_revision: parsed.expectedRevision,
        p_actor_email: ctx.actorEmail,
      });

      if (error) {
        await release();
        if (error.message?.includes('pricing_config_missing')) {
          return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
        }
        if (error.message?.includes('revision_conflict')) {
          return errorResponse(
            'REVISION_CONFLICT',
            'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
            409,
            ctx.requestId,
            { currentRevision: extractCurrentRevision(error) },
          );
        }
        if (error.message?.includes('draft_required')) {
          return errorResponse('VALIDATION_FAILED', 'Zapisz wersję roboczą przed publikacją.', 422, ctx.requestId);
        }
        if (error.message?.includes('pricing_invalid')) {
          // Contract's Error.fieldErrors is Record<string, string>: map every
          // key the RPC flagged to the same message. Reaching this branch
          // means the pre-flight above did not catch it (e.g. a concurrent
          // save landed in between), so a generic-but-correctly-keyed message
          // is the honest answer.
          const fieldErrors = Object.fromEntries(
            extractInvalidPricingKeys(error).map((key) => [key, 'Wartość poza dozwolonym zakresem.']),
          );
          return errorResponse('VALIDATION_FAILED', 'Cennik zawiera nieprawidłowe wartości.', 422, ctx.requestId, { fieldErrors });
        }
        throw error;
      }

      const resource = await loadPricingResource(ctx.supabase);
      await completeIdempotencyKey(ctx.supabase, 'pricing:publication', idempotencyKey, leaseToken, 200, resource);
      return jsonResponse(resource);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
