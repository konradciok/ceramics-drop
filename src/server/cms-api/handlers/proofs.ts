import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';

function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

const ACTIONS = ['approve', 'reject'] as const;

export const proofDecisionRoute: RouteDef = {
  method: 'POST',
  path: '/v1/products/{id}/proofs/{proofId}',
  handler: async (req, env, params, ctx) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }
    const parsed = body as { expectedRevision?: unknown; action?: unknown };
    if (typeof parsed.expectedRevision !== 'number' || !ACTIONS.includes(parsed.action as (typeof ACTIONS)[number])) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision and a valid action are required.', 422, ctx.requestId);
    }

    const { data, error } = await ctx.supabase.rpc('decide_print_proof', {
      p_asset_id: params.proofId,
      p_action: parsed.action,
      p_expected_revision: parsed.expectedRevision,
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
      if (error.message?.includes('proof_not_found')) {
        return errorResponse('NOT_FOUND', `Proof ${params.proofId} does not exist.`, 404, ctx.requestId);
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
      if (error.message?.includes('invalid_proof_transition')) {
        return errorResponse('INVALID_PROOF_TRANSITION', 'Ten proof nie oczekuje już na decyzję.', 409, ctx.requestId);
      }
      throw error;
    }

    const productId = (data as { productId: string }).productId;
    if (productId !== params.id) {
      return errorResponse('NOT_FOUND', `Proof ${params.proofId} does not belong to product ${params.id}.`, 404, ctx.requestId);
    }

    const updated = await loadProductResponse(ctx.supabase, env, productId);
    if (!updated) return errorResponse('NOT_FOUND', `Product ${productId} does not exist.`, 404, ctx.requestId);
    return jsonResponse(updated);
  },
};
