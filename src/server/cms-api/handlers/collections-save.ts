import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateCollectionSave } from '../collections-validation';
import { loadCollectionResponse } from '../collections-mapping';

// Same currentRevision=<n> detail-string parsing as products-save.ts's
// extractCurrentRevision (Global Constraint 8/21) — save_collection_draft
// raises 'revision_conflict' with that same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export const collectionsSaveRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/collections/{id}',
  handler: async (req, _env, params, ctx) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }

    if (typeof body !== 'object' || body === null) {
      return errorResponse('VALIDATION_FAILED', 'Request body must be a JSON object.', 422, ctx.requestId);
    }

    // ResourceSave is {expectedRevision, name, fields} — top-level, no
    // `draft` wrapper (Global Constraint 2, unlike products' {expectedRevision,
    // draft}). validateCollectionSave (Task 3) validates the whole shape at
    // once, including expectedRevision.
    const validated = validateCollectionSave(body);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }

    const { expectedRevision, name, fields } = validated.data;

    // p_payload is {name, fields} directly — matches collection_drafts.payload
    // and what collections-mapping.ts's loadCollectionResponse(s) reads back.
    const { error } = await ctx.supabase.rpc('save_collection_draft', {
      p_collection_id: params.id,
      p_expected_revision: expectedRevision,
      p_payload: { name, fields },
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
      if (error.message?.includes('collection_not_found')) {
        return errorResponse('NOT_FOUND', `Collection ${params.id} does not exist.`, 404, ctx.requestId);
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

    const collection = await loadCollectionResponse(ctx.supabase, params.id);
    return jsonResponse(collection);
  },
};
