import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { PRICING_RESOURCE_ID, loadPricingResource } from '../pricing-mapping';
import { fieldSchema, parsePricingFields } from '../pricing-validation';
import { derivePrice } from '@/lib/print-pricing';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import type { PrintSize } from '@/lib/types';
import { z } from 'zod';

// PricingPreview, verbatim from contracts/cms-v1.json.
const pricingPreviewSchema = z
  .object({ expectedRevision: z.number().int(), fields: z.array(fieldSchema) })
  .strict();

// Mirrors PricingEditor.tsx's own preview table exactly: one row per
// (group x size), one column per currency — 3 x 3 x 3 = 27 MoneyList items.
// The row labels are duplicated from that client component on purpose: it is a
// 'use client' React module, and importing it into a Worker handler to share
// three display strings would be strictly worse than restating them. These are
// presentation strings, not pricing truth — the numbers all come from
// derivePrice below.
const GROUPS = [
  { key: 'baseEur', label: 'Baza' },
  { key: 'frameEur', label: '+ Rama' },
  { key: 'mountEur', label: '+ Passe-partout' },
] as const;

const SIZES: readonly PrintSize[] = ['30x40', '50x70', '70x100'];

const SIZE_LABEL: Record<PrintSize, string> = {
  '30x40': '30 × 40 cm',
  '50x70': '50 × 70 cm',
  '70x100': '70 × 100 cm',
};

// MoneyList.items[].currency is a plain string; ISO 4217 uppercase is what the
// CMS feeds to Intl.NumberFormat (resource-editor.tsx). derivePrice takes the
// lowercase currency keys print-pricing.ts uses internally.
const CURRENCIES = [
  { code: 'EUR', key: 'eur' },
  { code: 'PLN', key: 'pln' },
  { code: 'GBP', key: 'gbp' },
] as const;

export type MoneyItem = { label: string; currency: string; minorUnits: number };

/**
 * The 27 component prices a candidate config produces. Pure; calls
 * print-pricing.ts's derivePrice UNMODIFIED — the exact function the
 * storefront, checkout and PricingEditor's own live preview all use, so what
 * this returns is what ships. Component-wise (base / frame / mount each
 * converted and rounded separately, then displayed separately) is also exactly
 * how priceOfVariant composes a variant total, so these items sum to real
 * variant prices — see pricing-preview.test.ts.
 *
 * All three currencies use 100 minor units per major unit (PLN grosz, EUR
 * cent, GBP penny), and derivePrice already returns whole units for PLN
 * (rounded to 5) and GBP (rounded to 1), so the x100 is exact for those and
 * exact for EUR too (whole euro integers).
 */
export function pricingPreviewItems(config: PrintPricingConfig): MoneyItem[] {
  const items: MoneyItem[] = [];
  for (const group of GROUPS) {
    for (const size of SIZES) {
      for (const currency of CURRENCIES) {
        items.push({
          label: `${group.label} ${SIZE_LABEL[size]}`,
          currency: currency.code,
          minorUnits: Math.round(derivePrice(config[group.key][size], currency.key, config) * 100),
        });
      }
    }
  }
  return items;
}

export const pricingPreviewPostRoute: RouteDef = {
  method: 'POST',
  path: '/v1/pricing/{id}/preview',
  handler: async (req, _env, params, ctx) => {
    if (params.id !== PRICING_RESOURCE_ID) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }

    const parsed = pricingPreviewSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_FAILED', 'Nieprawidłowe żądanie podglądu.', 422, ctx.requestId);
    }

    // Optimistic-concurrency guard, matching the CMS's local-dev mock
    // (cms-ceramics/src/lib/mock/store.ts calls requireRevision before every
    // action, preview included): previewing against a revision someone else
    // has already superseded would show numbers for a draft that no longer
    // exists.
    const current = await loadPricingResource(ctx.supabase);
    if (!current) {
      return errorResponse('NOT_FOUND', `Pricing ${params.id} does not exist.`, 404, ctx.requestId);
    }
    if (current.revision !== parsed.data.expectedRevision) {
      return errorResponse(
        'REVISION_CONFLICT',
        'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
        409,
        ctx.requestId,
        { currentRevision: current.revision },
      );
    }

    // The CANDIDATE values from the request body — the operator's unsaved,
    // in-form numbers — never the live print_pricing_config row. That is the
    // whole point of the endpoint: see the effect before publishing it.
    const validated = parsePricingFields(parsed.data.fields);
    if (!validated.ok) {
      return errorResponse('VALIDATION_FAILED', 'Cennik zawiera nieprawidłowe wartości.', 422, ctx.requestId, {
        fieldErrors: validated.fieldErrors,
      });
    }

    return jsonResponse({ items: pricingPreviewItems(validated.config) });
  },
};
