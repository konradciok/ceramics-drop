import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateUploadCreate } from '../uploads-validation';
import {
  UPLOAD_PRESIGN_TTL_SECS,
  buildUploadR2Key,
  insertUploadRow,
  mapUploadRowToIntent,
  presignUploadPutUrl,
  resolveR2PresignCredentials,
} from '../uploads-mapping';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// POST /v1/uploads: issues an upload intent (a new print_asset_uploads row)
// plus an R2 presigned PUT URL the client uploads the file bytes to directly
// — this handler never sees/proxies the bytes themselves. Idempotency-keyed
// per this codebase's established pattern (pricing-publication.ts /
// content-publication.ts / collections-create.ts).
export const uploadsCreateRoute: RouteDef = {
  method: 'POST',
  path: '/v1/uploads',
  handler: async (req, env, _params, ctx) => {
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

    const claim = await claimIdempotencyKey(ctx.supabase, 'uploads:create', idempotencyKey, body);
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;

    const validated = validateUploadCreate(body);
    if (!validated.ok) {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'uploads:create', idempotencyKey, leaseToken);
      } catch {
        // ignore — a failed release just leaves the lease in place; the 30s
        // LEASE_MS in idempotency.ts lets a later request reclaim it (same
        // rationale as collections-create.ts's equivalent branch).
      }
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }

    const upload = validated.data;

    try {
      const id = crypto.randomUUID();
      const r2Key = buildUploadR2Key(id, upload.contentType);
      const expiresAt = new Date(Date.now() + UPLOAD_PRESIGN_TTL_SECS * 1000).toISOString();

      // Resolve credentials and presign BEFORE writing anything — a
      // misconfigured deployment (missing R2_S3_* secrets) must fail closed
      // with no row left behind. insertUploadRow uses a fresh
      // crypto.randomUUID() every call (not derived from the idempotency
      // key), so a row committed here before a later step throws would be
      // orphaned: a client retry with the same Idempotency-Key would insert
      // a SECOND, unrelated row rather than resuming the failed one — the
      // idempotency ledger's replay only covers what this handler itself
      // completed, not partial DB side effects. Nothing below this point can
      // fail before the insert.
      const credentials = resolveR2PresignCredentials(env);
      const uploadUrl = await presignUploadPutUrl(credentials, r2Key);

      const row = await insertUploadRow(ctx.supabase, {
        id,
        filename: upload.filename,
        contentType: upload.contentType,
        bytes: upload.bytes,
        ratio: upload.ratio,
        r2Key,
        createdBy: ctx.actorEmail,
        expiresAt,
      });

      const intent = mapUploadRowToIntent(row, uploadUrl);
      await completeIdempotencyKey(ctx.supabase, 'uploads:create', idempotencyKey, leaseToken, 200, intent);
      return jsonResponse(intent, 200);
    } catch (err) {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'uploads:create', idempotencyKey, leaseToken);
      } catch {
        // ignore — see comment above
      }
      throw err;
    }
  },
};
