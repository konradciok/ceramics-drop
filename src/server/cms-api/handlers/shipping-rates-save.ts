import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateShippingRatesSave } from '../shipping-rates-validation';
import { isShippingRateId, loadShippingRateResource } from '../shipping-rates-mapping';

// Same currentRevision=<n> detail-string parsing as every other save handler
// (Global Constraint 8/21) — save_shipping_rate_draft raises
// 'revision_conflict' with that same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const shippingRatesSaveRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/shipping-rates/{id}',
  handler: async (req, _env, params, ctx) => {
    if (!isShippingRateId(params.id)) {
      return errorResponse('NOT_FOUND', `Shipping rates ${params.id} do not exist.`, 404, ctx.requestId);
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
    const validated = validateShippingRatesSave(body);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }
    const { expectedRevision, fields } = validated.data;
    // `name` is intentionally unused: each resource's display name is a fixed
    // SHIPPING_RATE_NAMES constant and shipping_rate_drafts.payload is {fields}
    // only. Same posture as pricing-save.ts / content-save.ts.

    // Deliberately NOT range-checked here. A draft may hold out-of-range or
    // half-typed values while the operator is mid-edit; the full parse and the
    // range re-validation happen at publish time — see
    // shipping-rates-publication.ts. This is what makes the draft table useful.
    const { error } = await ctx.supabase.rpc('save_shipping_rate_draft', {
      p_rate_id: params.id,
      p_expected_revision: expectedRevision,
      p_payload: { fields },
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
      if (error.message?.includes('shipping_rate_not_found')) {
        return errorResponse('NOT_FOUND', `Shipping rates ${params.id} do not exist.`, 404, ctx.requestId);
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

    const resource = await loadShippingRateResource(ctx.supabase, params.id);
    return jsonResponse(resource);
  },
};
