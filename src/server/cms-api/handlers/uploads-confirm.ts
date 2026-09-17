import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { confirmUploadRow, getUploadRowById, mapConfirmedUploadToAsset, type ConfirmedUploadRow } from '../uploads-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// print_asset_uploads.id is a uuid column — a malformed {id} would otherwise
// reach Postgres as an invalid-input-syntax error rather than a clean 404
// (same discipline as the migration's own invalid_asset_id guard in
// publish_print_asset_revision — validate the shape before trusting it in a
// typed comparison).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /v1/uploads/{id}/confirm: after the client has PUT the file bytes
// directly to R2 using the presigned URL from POST /v1/uploads, this checks
// the ACTUAL R2 object's metadata (existence, size, content-type) against
// what was declared at intent time — no Sharp, no image decoding, just an R2
// HEAD. On success the row moves pending -> confirmed (== "awaiting
// processing"; nothing in this phase processes it further — see the task
// brief's Phase 1/Phase 2 boundary).
//
// A row that is never confirmed (client never PUT, or PUT but never called
// this endpoint) simply stays `pending` past its print_asset_uploads.expires_at
// — nothing here or elsewhere sweeps/expires it yet. See that column's
// comment in the migration: enforcement needs scheduled/background
// execution this Worker doesn't have for this table yet, deliberately
// deferred to Phase 2's job-queue work, not silently dropped.
export const uploadsConfirmRoute: RouteDef = {
  method: 'POST',
  path: '/v1/uploads/{id}/confirm',
  handler: async (req, env, params, ctx) => {
    if (!UUID_RE.test(params.id)) {
      return errorResponse('NOT_FOUND', `Upload ${params.id} does not exist.`, 404, ctx.requestId);
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
    // Revision schema is bare {expectedRevision} — same convention as every
    // other publication-shaped handler (pricing-publication.ts et al.).
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }
    const expectedRevision = parsed.expectedRevision as number;

    const claim = await claimIdempotencyKey(ctx.supabase, 'uploads:confirm', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    const release = async () => {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'uploads:confirm', idempotencyKey, leaseToken);
      } catch {
        // ignore — a failed release just leaves the lease in place; the 30s
        // LEASE_MS in idempotency.ts lets a later request reclaim it (same
        // rationale as pricing-publication.ts's release()).
      }
    };

    try {
      const current = await getUploadRowById(ctx.supabase, params.id);
      if (!current) {
        await release();
        return errorResponse('NOT_FOUND', `Upload ${params.id} does not exist.`, 404, ctx.requestId);
      }
      if (current.revision !== expectedRevision) {
        await release();
        return errorResponse(
          'REVISION_CONFLICT',
          'Ten upload został już potwierdzony lub zmienił stan. Utwórz nowy upload.',
          409,
          ctx.requestId,
          { currentRevision: current.revision },
        );
      }

      const object = await env.PRINT_ASSETS.head(current.r2_key);
      if (!object) {
        await release();
        return errorResponse('VALIDATION_FAILED', 'Nie znaleziono przesłanego pliku w magazynie R2.', 422, ctx.requestId);
      }

      const fieldErrors: Record<string, string> = {};
      if (object.size !== current.declared_byte_size) {
        fieldErrors.bytes = `Rozmiar pliku (${object.size}) różni się od zadeklarowanego (${current.declared_byte_size}).`;
      }
      const observedContentType = object.httpMetadata?.contentType;
      if (observedContentType !== current.content_type) {
        fieldErrors.contentType = `Typ pliku (${observedContentType ?? 'nieznany'}) różni się od zadeklarowanego (${current.content_type}).`;
      }
      if (Object.keys(fieldErrors).length > 0) {
        await release();
        return errorResponse('VALIDATION_FAILED', 'Przesłany plik nie zgadza się z deklaracją.', 422, ctx.requestId, { fieldErrors });
      }

      const updated = await confirmUploadRow(ctx.supabase, params.id, expectedRevision, {
        byteSize: object.size,
        contentType: observedContentType,
      });
      if (!updated) {
        // Lost a race against a concurrent confirm of the same row between
        // the read above and this CAS write — same REVISION_CONFLICT
        // response, just without a fresh currentRevision to report.
        await release();
        return errorResponse('REVISION_CONFLICT', 'Ten upload został już potwierdzony przez inne żądanie.', 409, ctx.requestId);
      }

      const asset = mapConfirmedUploadToAsset(updated as ConfirmedUploadRow);
      await completeIdempotencyKey(ctx.supabase, 'uploads:confirm', idempotencyKey, leaseToken, 200, asset);
      return jsonResponse(asset, 200);
    } catch (err) {
      await release();
      throw err;
    }
  },
};
