import { z } from 'zod';

const CATEGORY_SLUGS = [
  'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
  'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
] as const;
const PRINT_SIZES = ['30x40', '50x70', '70x100'] as const;
const PRINT_FRAME_COLOURS = ['black', 'natural', 'brown'] as const;

const localizedTextSchema = z
  .object({ pl: z.string().min(1), en: z.string().optional(), es: z.string().optional(), de: z.string().optional() })
  .strict();

const localizedTextOptionalSchema = z
  .object({ pl: z.string().optional(), en: z.string().optional(), es: z.string().optional(), de: z.string().optional() })
  .strict();

const ceramicDraftSchema = z
  .object({
    type: z.literal('ceramic'),
    category: z.enum(CATEGORY_SLUGS),
    displayNumber: z.string().min(1),
    measure: z.string(),
    pricePln: z.number().int().positive(),
    priceEur: z.number().int().positive(),
    priceGbp: z.number().int().positive(),
    images: z.array(z.string().min(1)).min(1),
    title: localizedTextSchema,
    description: localizedTextSchema,
    seo: localizedTextOptionalSchema.optional(),
    showroom: z.boolean(),
    dropId: z.string().optional(),
  })
  .strict();

const printDraftSchema = z
  .object({
    type: z.literal('print'),
    displayNumber: z.string().min(1),
    sizes: z.array(z.enum(PRINT_SIZES)).min(1),
    frameColours: z.array(z.enum(PRINT_FRAME_COLOURS)).optional(),
    mountAvailable: z.boolean(),
    unavailable: z.array(z.string()).optional(),
    images: z.array(z.string().min(1)).min(1),
    title: localizedTextSchema,
    description: localizedTextSchema,
    seo: localizedTextOptionalSchema.optional(),
  })
  .strict();

export const productDraftSchema = z.discriminatedUnion('type', [ceramicDraftSchema, printDraftSchema]);

export type ValidationResult =
  | { ok: true; data: z.infer<typeof productDraftSchema> }
  | { ok: false; fieldErrors: Record<string, string> };

export function validateProductDraft(body: unknown): ValidationResult {
  const result = productDraftSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return { ok: false, fieldErrors };
}
