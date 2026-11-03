import { z } from 'zod';

// Field/ResourceCreate/ResourceSave, verbatim from contracts/cms-v1.json —
// greenfield (no product-draft precedent to mirror the shape of; see
// Global Constraint 18). Structural conventions (strict object schemas,
// fieldErrors reporting) mirror validation.ts's validateProductDraft.
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

// name requires a non-blank value after trimming — matches the CMS's
// local-dev mock (cms-ceramics/src/lib/mock/store.ts's `name: z.string()
// .trim().min(1)`), which is the parity target per Global Constraint 18.
// The contract itself only requires `name` be a string.
export const resourceCreateSchema = z.object({ name: z.string().trim().min(1) }).strict();

export const resourceSaveSchema = z
  .object({
    expectedRevision: z.number().int(),
    name: z.string().trim().min(1),
    fields: z.array(fieldSchema),
  })
  .strict();

export type CollectionCreateResult =
  | { ok: true; data: z.infer<typeof resourceCreateSchema> }
  | { ok: false; fieldErrors: Record<string, string> };

export type CollectionSaveResult =
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

export function validateCollectionCreate(body: unknown): CollectionCreateResult {
  const result = resourceCreateSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}

export function validateCollectionSave(body: unknown): CollectionSaveResult {
  const result = resourceSaveSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}
