import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateCollectionCreate } from '../collections-validation';
import { loadCollectionResponse } from '../collections-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';
import type { Field } from '../types';

function generateCollectionId(): string {
  return `col_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

// Default payload seeded on create — Global Constraint 3's Field shape, five
// fields total: four locale description fields plus one productIds-type
// field. key/label values mirror cms-ceramics' own mock fixture for its
// default collection (src/lib/mock/fixtures.ts's `collection-01`: a single
// `key: "description"` distinguished per-locale by the `locale` field rather
// than a per-locale key suffix, plus a `key: "products"` productIds field) —
// that mock is this API's local-dev parity target (Global Constraint 18).
// sourceLocale is "pl" on every description field (including the pl one
// itself), matching the same fixture's `content` resources, which always
// carry `sourceLocale: "pl"` regardless of the field's own locale — pl is
// the translation source of truth.
function defaultFields(): Field[] {
  return [
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'pl', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'en', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'es', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'de', sourceLocale: 'pl' },
    { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: '', locale: 'none', sourceLocale: 'none' },
  ];
}

export const collectionsCreateRoute: RouteDef = {
  method: 'POST',
  path: '/v1/collections',
  handler: async (req, _env, _params, ctx) => {
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

    const claim = await claimIdempotencyKey(ctx.supabase, 'collections:create', idempotencyKey, body);
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    const validated = validateCollectionCreate(body);
    if (!validated.ok) {
      // Swallow a release failure so it can't replace the 422
      // VALIDATION_FAILED response below — a failed release just leaves the
      // lease in place, and the 30s LEASE_MS in idempotency.ts lets a later
      // request reclaim it, so this is a safe no-op (same rationale as
      // collections-publication.ts's / collections-restore.ts's catch-block
      // release).
      try {
        await releaseIdempotencyKey(ctx.supabase, 'collections:create', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }

    const payload = { name: validated.data.name, fields: defaultFields() };

    try {
      let collectionId = generateCollectionId();
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await ctx.supabase.rpc('create_collection_with_draft', {
          p_id: collectionId,
          p_payload: payload,
          p_actor_email: ctx.actorEmail,
        });
        if (!error) break;
        if (error.code === '23505' && attempt < 2) {
          collectionId = generateCollectionId();
          continue;
        }
        throw error;
      }

      const collection = await loadCollectionResponse(ctx.supabase, collectionId);
      await completeIdempotencyKey(ctx.supabase, 'collections:create', idempotencyKey, leaseToken, 200, collection);
      return jsonResponse(collection, 200);
    } catch (err) {
      // Swallow a release failure here so the original error (err) always
      // propagates instead of being replaced by the release failure — same
      // rationale as the comment above.
      try {
        await releaseIdempotencyKey(ctx.supabase, 'collections:create', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      throw err;
    }
  },
};
