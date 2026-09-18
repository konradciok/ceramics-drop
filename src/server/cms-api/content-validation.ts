import { z } from 'zod';

// Generic ResourceSave shape, verbatim from contracts/cms-v1.json — the
// same contract collections-validation.ts's resourceSaveSchema validates
// (Field/ResourceSave are shared verbatim across all four resource kinds
// per types.ts). Kept as its own module (rather than reusing
// collections-validation.ts) to match this codebase's one-module-per-kind
// convention; there is no content-specific ResourceCreate schema because
// content documents are a fixed allowlist with no POST /v1/content create
// endpoint (Task 5 brief).
const FIELD_TYPES = ['text', 'richtext', 'number', 'productIds'] as const;
const FIELD_LOCALES = ['pl', 'en', 'es', 'de', 'none'] as const;

export const fieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(FIELD_TYPES),
    value: z.string(),
    locale: z.enum(FIELD_LOCALES),
    sourceLocale: z.enum(FIELD_LOCALES),
  })
  .strict();

// `name` is required by the generic contract, but content-save.ts never
// persists the submitted value — a content document's display name is
// content.ts's own fixed EditableContentDocument.label, not a stored,
// editable field (see content-save.ts). Still validated here (non-blank)
// so a malformed body fails the same way every other resource kind's does.
export const resourceSaveSchema = z
  .object({
    expectedRevision: z.number().int(),
    name: z.string().trim().min(1),
    fields: z.array(fieldSchema),
  })
  .strict();

export type ContentSaveResult =
  | { ok: true; data: z.infer<typeof resourceSaveSchema> }
  | { ok: false; fieldErrors: Record<string, string> };

function collectFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

export function validateContentSave(body: unknown): ContentSaveResult {
  const result = resourceSaveSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}
