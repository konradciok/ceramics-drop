import { z } from 'zod';

// Upload, verbatim from contracts/cms-v1.json (POST /v1/uploads request
// body). Structural conventions (strict object schema, fieldErrors
// reporting) mirror collections-validation.ts's validateCollectionCreate.
const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

export const uploadCreateSchema = z
  .object({
    filename: z.string().trim().min(1),
    contentType: z.enum(UPLOAD_CONTENT_TYPES),
    bytes: z.number().int().positive(),
    ratio: z.string().trim().min(1),
  })
  .strict();

export type UploadCreateResult =
  | { ok: true; data: z.infer<typeof uploadCreateSchema> }
  | { ok: false; fieldErrors: Record<string, string> };

function collectFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

export function validateUploadCreate(body: unknown): UploadCreateResult {
  const result = uploadCreateSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}
