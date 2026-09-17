import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { validateContentSave } from '../content-validation';
import { decodeContentResourceId, loadContentResourceState, loadContentResource, unflattenContentFields } from '../content-mapping';
import { saveDraft } from '@/lib/admin/content';
import { zodIssues } from '@/lib/cms/schemas';

export const contentSaveRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/content/{id}',
  handler: async (req, _env, params, ctx) => {
    const parts = decodeContentResourceId(params.id);
    if (!parts) {
      return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
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

    // ResourceSave is {expectedRevision, name, fields} — top-level, no
    // `draft` wrapper (same generic contract as collections-save.ts).
    const validated = validateContentSave(body);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors: validated.fieldErrors });
    }
    const { expectedRevision, fields } = validated.data;
    // `name` is intentionally unused below — see content-validation.ts: a
    // content document's name is content.ts's own fixed
    // EditableContentDocument.label, never a client-editable, persisted value.

    // content.ts's saveDraft has no built-in optimistic-concurrency check
    // (unlike collections'/products' RPCs, which raise revision_conflict
    // themselves) — this handler enforces the same expectedRevision-must-
    // match-current contract every other resource kind honours, by reading
    // the current state first. This is a read-then-write check (a
    // concurrent save between this read and content.ts's write could still
    // race), not the atomic DB-level CAS collections/products get — an
    // accepted trade-off given content.ts stays unmodified (Task 5 brief);
    // low-risk for a single-operator admin panel.
    const current = await loadContentResourceState(parts.kind, parts.slug, parts.locale);
    if (!current) {
      return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
    }
    if (current.resource.revision !== expectedRevision) {
      return errorResponse(
        'REVISION_CONFLICT',
        'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
        409,
        ctx.requestId,
        { currentRevision: current.resource.revision },
      );
    }

    // currentPayload is passed through so unflattenContentFields can carry
    // home's media slot forward untouched — media is out of this API's
    // Field surface entirely (Task 5 brief); see content-mapping.ts.
    const payload = unflattenContentFields({ kind: parts.kind, slug: parts.slug }, fields, current.payload);

    try {
      await saveDraft({ kind: parts.kind, slug: parts.slug, locale: parts.locale, payload, actorEmail: ctx.actorEmail });
    } catch (err) {
      // content.ts's saveDraft validates the reconstructed payload itself
      // via validateCmsPayload (cms/schemas.ts) and throws a ZodError on
      // failure — e.g. a product_notes save missing a note for a live
      // catalogue id. zodIssues() already knows how to turn that into
      // fieldErrors; a non-Zod error (e.g. 'unsupported_document', which
      // should not occur here since decodeContentResourceId already
      // validated kind/slug) is defensively mapped to 404, anything else
      // rethrown as a 500.
      const fieldErrors = zodIssues(err);
      if (Object.keys(fieldErrors).length > 0) {
        return errorResponse('VALIDATION_FAILED', 'Formularz zawiera błędy.', 422, ctx.requestId, { fieldErrors });
      }
      if (err instanceof Error && (err.message === 'unsupported_document' || err.message === 'document_not_found')) {
        return errorResponse('NOT_FOUND', `Content ${params.id} does not exist.`, 404, ctx.requestId);
      }
      throw err;
    }

    const resource = await loadContentResource(parts.kind, parts.slug, parts.locale);
    return jsonResponse(resource);
  },
};
