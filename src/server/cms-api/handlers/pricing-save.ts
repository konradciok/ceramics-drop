import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validatePricingSave } from '../pricing-validation';
import { PRICING_RESOURCE_ID, loadPricingResource } from '../pricing-mapping';

// Same currentRevision=<n> detail-string parsing as products-save.ts's /
// collections-save.ts's extractCurrentRevision (Global Constraint 8/21) —
// save_pricing_draft raises 'revision_conflict' with that same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const pricingSaveRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/pricing/{id}',
  handler: async (req, _env, params, ctx) => {
    if (params.id !== PRICING_RESOURCE_ID) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
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

    // ResourceSave is {expectedRevision, name, fields} — top-level, no `draft`
    // wrapper (Global Constraint 2), same as collections-save.ts.
    const validated = validatePricingSave(body);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }
    const { expectedRevision, fields } = validated.data;
    // `name` is intentionally unused: the pricing resource's display name is
    // the fixed PRICING_RESOURCE_NAME constant, and pricing_config_drafts.payload
    // is {fields} only (see pricing-mapping.ts / the migration). Same posture
    // as content-save.ts.

    // Deliberately NOT range-checked here. A draft may hold out-of-range or
    // half-typed values while the operator is mid-edit; the 11-key parse and
    // the range re-validation happen at publish (and preview) time — see
    // pricing-publication.ts. This is what makes the draft table useful at all.
    const { error } = await ctx.supabase.rpc('save_pricing_draft', {
      p_expected_revision: expectedRevision,
      p_payload: { fields },
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
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
      throw error;
    }

    const resource = await loadPricingResource(ctx.supabase);
    return jsonResponse(resource);
  },
};
