import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pricingPreviewPostRoute, pricingPreviewItems } from './pricing-preview';
import type { HandlerContext } from '../router';
import * as pricingMapping from '../pricing-mapping';
import { PRICING_RESOURCE_ID, PRICING_RESOURCE_NAME, buildPricingFields } from '../pricing-mapping';
import { DEFAULT_PRINT_PRICING, derivePrice, priceOfVariant } from '@/lib/print-pricing';

vi.mock('../pricing-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof pricingMapping>()),
  loadPricingResource: vi.fn(),
}));

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

const defaultFields = buildPricingFields(DEFAULT_PRINT_PRICING);

function currentIs(revision: number) {
  vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue({
    id: PRICING_RESOURCE_ID,
    kind: 'pricing',
    name: PRICING_RESOURCE_NAME,
    revision,
    publishedRevision: revision,
    fields: defaultFields,
  });
}

async function preview(body: unknown, id = PRICING_RESOURCE_ID) {
  return pricingPreviewPostRoute.handler(
    new Request('https://x.test/v1/pricing/print-pricing/preview', { method: 'POST', body: JSON.stringify(body) }),
    {} as CloudflareEnv,
    { id },
    ctx,
  );
}

describe('pricingPreviewItems (pure)', () => {
  it('produces 27 items: 3 groups x 3 sizes x 3 currencies', () => {
    const items = pricingPreviewItems(DEFAULT_PRINT_PRICING);
    expect(items).toHaveLength(27);
    expect(new Set(items.map((i) => i.currency))).toEqual(new Set(['EUR', 'PLN', 'GBP']));
    expect(new Set(items.map((i) => i.label)).size).toBe(9);
  });

  it('reports EUR values as the config integers in minor units', () => {
    const items = pricingPreviewItems(DEFAULT_PRINT_PRICING);
    const base3040Eur = items.find((i) => i.label === 'Baza 30 × 40 cm' && i.currency === 'EUR');
    expect(base3040Eur?.minorUnits).toBe(2500);
  });

  it('uses derivePrice verbatim for PLN and GBP (5 zł / 1 £ rounding included)', () => {
    const items = pricingPreviewItems(DEFAULT_PRINT_PRICING);
    for (const [label, group] of [
      ['Baza', 'baseEur'],
      ['+ Rama', 'frameEur'],
      ['+ Passe-partout', 'mountEur'],
    ] as const) {
      for (const [sizeLabel, size] of [
        ['30 × 40 cm', '30x40'],
        ['50 × 70 cm', '50x70'],
        ['70 × 100 cm', '70x100'],
      ] as const) {
        for (const [code, key] of [
          ['EUR', 'eur'],
          ['PLN', 'pln'],
          ['GBP', 'gbp'],
        ] as const) {
          const item = items.find((i) => i.label === `${label} ${sizeLabel}` && i.currency === code);
          expect(item?.minorUnits).toBe(
            Math.round(derivePrice(DEFAULT_PRINT_PRICING[group][size], key, DEFAULT_PRINT_PRICING) * 100),
          );
        }
      }
    }
  });

  // The preview table is component-wise, and priceOfVariant composes a variant
  // total from exactly those components — so the items must add up to real,
  // sellable variant prices. This is the check that the preview is not just
  // self-consistent but agrees with what checkout charges.
  it('component items sum to priceOfVariant for every variant shape and currency', () => {
    const items = pricingPreviewItems(DEFAULT_PRINT_PRICING);
    const minor = (label: string, currency: string) =>
      items.find((i) => i.label === label && i.currency === currency)!.minorUnits;

    for (const [sizeLabel, size] of [
      ['30 × 40 cm', '30x40'],
      ['50 × 70 cm', '50x70'],
      ['70 × 100 cm', '70x100'],
    ] as const) {
      for (const [code, key] of [
        ['EUR', 'eur'],
        ['PLN', 'pln'],
        ['GBP', 'gbp'],
      ] as const) {
        const base = minor(`Baza ${sizeLabel}`, code);
        const frame = minor(`+ Rama ${sizeLabel}`, code);
        const mount = minor(`+ Passe-partout ${sizeLabel}`, code);

        expect(base).toBe(priceOfVariant({ size, framed: false, mount: false, frameColour: 'none' }, key, DEFAULT_PRINT_PRICING) * 100);
        expect(base + frame).toBe(priceOfVariant({ size, framed: true, mount: false, frameColour: 'black' }, key, DEFAULT_PRINT_PRICING) * 100);
        expect(base + frame + mount).toBe(priceOfVariant({ size, framed: true, mount: true, frameColour: 'black' }, key, DEFAULT_PRINT_PRICING) * 100);
      }
    }
  });

  it('reflects a changed FX rate rather than the defaults', () => {
    const doubled = { ...DEFAULT_PRINT_PRICING, eurToPln: 8.5 };
    const item = pricingPreviewItems(doubled).find((i) => i.label === 'Baza 30 × 40 cm' && i.currency === 'PLN');
    // 25 EUR x 8.5 = 212.5 -> nearest 5 zł = 215
    expect(item?.minorUnits).toBe(21500);
  });
});

describe('pricingPreviewPostRoute', () => {
  beforeEach(() => currentIs(3));

  it('404s an id other than the singleton id', async () => {
    const res = await preview({ expectedRevision: 3, fields: defaultFields }, 'nope');
    expect(res.status).toBe(404);
  });

  it('computes against the CANDIDATE body fields, not the stored draft', async () => {
    const candidate = defaultFields.map((f) => (f.key === 'base_30x40_eur' ? { ...f, value: '40' } : f));
    const res = await preview({ expectedRevision: 3, fields: candidate });
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: { label: string; currency: string }) => i.label === 'Baza 30 × 40 cm' && i.currency === 'EUR');
    expect(item.minorUnits).toBe(4000);
    expect(body.items).toHaveLength(27);
  });

  it('409s a stale expectedRevision', async () => {
    const res = await preview({ expectedRevision: 1, fields: defaultFields });
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(3);
  });

  it('422s an out-of-range candidate with per-field errors', async () => {
    const candidate = defaultFields.map((f) => (f.key === 'eur_to_pln' ? { ...f, value: '0' } : f));
    const res = await preview({ expectedRevision: 3, fields: candidate });
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toHaveProperty('eur_to_pln');
  });

  it('422s a malformed PricingPreview body', async () => {
    expect((await preview({ fields: defaultFields })).status).toBe(422);
    expect((await preview({ expectedRevision: 3 })).status).toBe(422);
  });

  it('404s when the live singleton row is absent', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(null);
    const res = await preview({ expectedRevision: 3, fields: defaultFields });
    expect(res.status).toBe(404);
  });
});
