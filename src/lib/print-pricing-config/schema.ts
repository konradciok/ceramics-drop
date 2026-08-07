/* ============================================================
   Print pricing config schema — validates the admin write and the DB read.
   Client-safe (zod + types only). Values are whole EUR (major units); the
   two rates allow up to 4 decimals to match the numeric(8,4) columns.
   ============================================================ */
import { z } from 'zod';
import type { PrintPricingConfig } from '../print-pricing';

const eurValue = (min: number) => z.number().int().min(min).max(1_000_000);

const perSize = (min: number) =>
  z
    .object({ '30x40': eurValue(min), '50x70': eurValue(min), '70x100': eurValue(min) })
    .strict();

const rate = z
  .number()
  .positive()
  .max(100)
  .refine((v) => Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6, {
    message: 'Rate supports at most 4 decimal places',
  });

export const printPricingConfigSchema = z
  .object({
    baseEur: perSize(1),
    frameEur: perSize(0),
    mountEur: perSize(0),
    eurToPln: rate,
    eurToGbp: rate,
  })
  .strict();

// Compile-time lockstep: the schema output must stay assignable to the domain
// type (and vice versa) so a drift in either is a build error, not a runtime one.
const _schemaMatchesType: PrintPricingConfig = {} as z.infer<typeof printPricingConfigSchema>;
const _typeMatchesSchema: z.infer<typeof printPricingConfigSchema> = {} as PrintPricingConfig;
void _schemaMatchesType;
void _typeMatchesSchema;
