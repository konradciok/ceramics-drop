import { z } from 'zod';
import { MIN_CERAMIC_PRICE_MAJOR } from '@/lib/pricing';

// Exported so mapping.ts's synthesizeDraft() can reject a DB row whose
// category_slug isn't a valid ceramic category using this exact same list —
// products.category_slug is only `text not null` in the schema (no CHECK
// tying it to type), so this is the one place that enumerates the valid set.
export const CATEGORY_SLUGS = [
  'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
  'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  'talerze-owalne', 'talerze-male',
] as const;
const PRINT_SIZES = ['30x40', '50x70', '70x100'] as const;
const PRINT_FRAME_COLOURS = ['black', 'natural', 'brown'] as const;

const localizedTextSchema = z
  .object({ pl: z.string().min(1), en: z.string().optional(), es: z.string().optional(), de: z.string().optional() })
  .strict();

const localizedTextOptionalSchema = z
  .object({ pl: z.string().optional(), en: z.string().optional(), es: z.string().optional(), de: z.string().optional() })
  .strict();

// Draft prices are minor units (grosze / euro-cents / pence, per
// contracts/cms-v1.json) but products.price_* stores WHOLE units, and
// publication divides by 100. So a price must be a whole major unit (no
// silent rounding of 28.50 € to 29 €) and at least MIN_CERAMIC_PRICE_MAJOR —
// otherwise a major-unit value typed into a minor-unit field (95 meaning
// 95 zł) would publish as 1 zł / 0 € (CO-03).
const MIN_CERAMIC_PRICE_MINOR = MIN_CERAMIC_PRICE_MAJOR * 100;
const ceramicPriceMinorSchema = z
  .number()
  .int()
  .min(MIN_CERAMIC_PRICE_MINOR, `Cena musi wynosić co najmniej ${MIN_CERAMIC_PRICE_MAJOR} (podaj ją w groszach/centach, np. ${MIN_CERAMIC_PRICE_MINOR}).`)
  .multipleOf(100, 'Cena musi być pełną kwotą (w groszach/centach: wielokrotność 100).');

const ceramicPriceFieldsSchema = z.object({
  pricePln: ceramicPriceMinorSchema,
  priceEur: ceramicPriceMinorSchema,
  priceGbp: ceramicPriceMinorSchema,
});

const ceramicDraftSchema = z
  .object({
    type: z.literal('ceramic'),
    category: z.enum(CATEGORY_SLUGS),
    displayNumber: z.string().min(1),
    measure: z.string().min(1),
    ...ceramicPriceFieldsSchema.shape,
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

function toFieldErrors(issues: z.core.$ZodIssue[]): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

export function validateProductDraft(body: unknown): ValidationResult {
  const result = productDraftSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: toFieldErrors(result.error.issues) };
}

/**
 * Re-check just the ceramic price fields of a stored draft at publish time.
 * The publication handler cannot assume the draft went through
 * validateProductDraft: a product with no saved draft gets one synthesized
 * from its live DB row (mapping.ts synthesizeDraft, NULL price → 0), and a
 * draft saved before this rule existed is stored as-is. Returns null when
 * every price is publishable.
 */
export function ceramicDraftPriceErrors(draft: {
  pricePln: unknown;
  priceEur: unknown;
  priceGbp: unknown;
}): Record<string, string> | null {
  const result = ceramicPriceFieldsSchema.safeParse({
    pricePln: draft.pricePln,
    priceEur: draft.priceEur,
    priceGbp: draft.priceGbp,
  });
  return result.success ? null : toFieldErrors(result.error.issues);
}
