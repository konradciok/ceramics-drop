import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateProductDraft } from '../validation';
import { loadProductResponse } from '../mapping';

function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const productsSaveRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/products/{id}',
  handler: async (req, env, params, ctx) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }

    const parsed = body as { expectedRevision?: unknown; draft?: unknown };
    if (typeof parsed.expectedRevision !== 'number') {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const validated = validateProductDraft(parsed.draft);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }

    const { error } = await ctx.supabase.rpc('save_product_draft', {
      p_product_id: params.id,
      p_expected_revision: parsed.expectedRevision,
      p_payload: validated.data,
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
      if (error.message?.includes('product_not_found')) {
        return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
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

    const product = await loadProductResponse(ctx.supabase, env, params.id);
    return jsonResponse(product);
  },
};
