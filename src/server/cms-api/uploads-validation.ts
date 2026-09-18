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
    // Shape-only here (non-empty string). Membership of the real print-ratio
    // set is checked in uploads-create.ts via profiles.ts's isPrintRatio —
    // the same predicate process-job.ts applies — so this module stays free of
    // the print-pipeline import. The check happens at upload-intent time
    // either way; see uploads-create.ts's fieldErrors.ratio branch.
    ratio: z.string().trim().min(1),
    // Task 12: closes the product-association gap Task 11's Container
    // processor self-flagged — required going forward (nothing in this
    // pipeline has been deployed yet, so there is no backward-compatibility
    // constraint to preserve). Shape-only here (non-empty string); whether it
    // actually names a real, active print product is a DB-backed check the
    // handler performs via profiles.ts's loadActivePrintVariants, not
    // something zod can validate.
    productId: z.string().trim().min(1),
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
