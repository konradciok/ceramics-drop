import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateCollectionSave } from '../collections-validation';
import { loadCollectionResponse } from '../collections-mapping';
import type { Field } from '../types';

// Same currentRevision=<n> detail-string parsing as products-save.ts's
// extractCurrentRevision (Global Constraint 8/21) — save_collection_draft
// raises 'revision_conflict' with that same detail format.
function extractCurrentRevision(error: { details?: string | null; message?: string }): number | undefined {
  const source = `${error.message ?? ''} ${error.details ?? ''}`;
  const match = source.match(/currentRevision=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

// Task 1 — Protect the print-collection kind tag. The storefront
// (ceramics-drop/src/lib/print-collections.ts) only surfaces a collection
// whose `kind` field is exactly 'print-collection'. resource-editor.tsx
// (cms-ceramics) renders every non-richtext/productIds field — including
// `kind` — as a generic editable text input, and nothing downstream of that
// (the Zod schema, this handler, or the RPC) rejected an arbitrary string
// there. This carries the prior draft's `kind` field forward untouched on
// every save, ignoring whatever the client submitted for that key — a
// changed value is overridden, an omitted one is silently re-added. A
// collection that has never had a `kind` field is left exactly as
// submitted: this only protects an EXISTING value, it never invents one
// (Task 1 brief).
function withProtectedKind(currentFields: Field[], incomingFields: Field[]): Field[] {
  const priorKind = currentFields.find((f) => f.key === 'kind');
  if (!priorKind) return incomingFields;
  const hasIncomingKind = incomingFields.some((f) => f.key === 'kind');
  if (hasIncomingKind) {
    return incomingFields.map((f) => (f.key === 'kind' ? priorKind : f));
  }
  return [...incomingFields, priorKind];
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

    // Pre-persist step (Task 1): look up the collection's current draft
    // before saving so withProtectedKind can carry its `kind` field forward
    // regardless of what the client just submitted. If the collection
    // doesn't exist, this resolves to null/no fields — fields pass through
    // unchanged and the RPC call below still raises collection_not_found
    // exactly as before.
    const current = await loadCollectionResponse(ctx.supabase, params.id);
    const protectedFields = withProtectedKind(current?.fields ?? [], fields);

    // p_payload is {name, fields} directly — matches collection_drafts.payload
    // and what collections-mapping.ts's loadCollectionResponse(s) reads back.
    const { error } = await ctx.supabase.rpc('save_collection_draft', {
      p_collection_id: params.id,
      p_expected_revision: expectedRevision,
      p_payload: { name, fields: protectedFields },
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
