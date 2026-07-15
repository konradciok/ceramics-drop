import { describe, it, expect } from 'vitest';
import { validateCart } from './checkout';
import { PRICE_PLN, SHIPPING_PLN, toMinor, orderAmountGrosze, shippingGrosze, priceOf, priceOfCurrency, shippingOfCurrency } from './pricing';
import { PRICE_EUR, SHIPPING_EUR, shippingEuroCents, orderAmountEuroCents } from './pricing';
import { PRICE_GBP, SHIPPING_GBP, shippingGBPPence, orderAmountGBPPence } from './pricing';
import type { CategorySlug } from './types';

describe('pricing', () => {
  it('exposes PLN prices for all nine categories', () => {
    expect(PRICE_PLN).toEqual({
      kubki: 95,
      wazony: 239,
      'wazony-srednie': 289,
      'wazony-duze': 379,
      talerzyki: 69,
      'talerze-srednie': 119,
      'talerze-duze': 160,
      'duze-michy': 345,
      'miski-falowane': 195,
      'fine-art-prints': 0,
    });
  });

  it('exposes a per-method shipping price map', () => {
    expect(SHIPPING_PLN.kurier).toBe(30);
    expect(SHIPPING_PLN.paczkomat).toBe(20);
    expect(SHIPPING_PLN.odbior).toBe(0);
  });

  it('converts major units to minor units (×100)', () => {
    expect(toMinor(90)).toBe(9000);
    expect(toMinor(0)).toBe(0);
  });

  it('computes shipping grosze per method', () => {
    expect(shippingGrosze('paczkomat')).toBe(2000);
    expect(shippingGrosze('kurier')).toBe(3000);
    expect(shippingGrosze('odbior')).toBe(0);
  });

  it('sums item grosze plus courier shipping', () => {
    const amount = orderAmountGrosze([9000, 21000], 'kurier');
    expect(amount).toBe(9000 + 21000 + 3000);
  });

  it('sums item grosze plus paczkomat shipping', () => {
    expect(orderAmountGrosze([9000], 'paczkomat')).toBe(9000 + 2000);
  });

  it('charges no shipping for pickup', () => {
    expect(orderAmountGrosze([9000], 'odbior')).toBe(9000);
  });
});

describe('priceOf', () => {
  const ALL_CATEGORIES: CategorySlug[] = [
    'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
    'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  ];

  it('returns PLN price for pl locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'pl')).toBe(PRICE_PLN.kubki);
  });

  it('returns EUR price for en locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'en')).toBe(PRICE_EUR.kubki);
  });

  it('returns EUR price for es locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'es')).toBe(PRICE_EUR.kubki);
  });

  it('returns EUR price for de locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'de')).toBe(PRICE_EUR.kubki);
  });

  it('resolves all nine categories correctly for pl and en', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(priceOf({ category: cat, price: PRICE_PLN[cat] }, 'pl')).toBe(PRICE_PLN[cat]);
      expect(priceOf({ category: cat, price: PRICE_PLN[cat] }, 'en')).toBe(PRICE_EUR[cat]);
    }
  });
});

describe('GBP pricing helpers', () => {
  it('PRICE_GBP covers every category with the expected values', () => {
    expect(PRICE_GBP).toEqual({
      kubki: 22,
      wazony: 50,
      'wazony-srednie': 58,
      'wazony-duze': 75,
      talerzyki: 15,
      'talerze-srednie': 24,
      'talerze-duze': 32,
      'duze-michy': 75,
      'miski-falowane': 42,
      'fine-art-prints': 0,
    });
  });

  it('SHIPPING_GBP has expected values for all methods', () => {
    expect(SHIPPING_GBP.paczkomat).toBe(5);
    expect(SHIPPING_GBP.kurier).toBe(12);
    expect(SHIPPING_GBP.odbior).toBe(0);
  });

  it('shippingGBPPence returns correct pence for all methods', () => {
    expect(shippingGBPPence('paczkomat')).toBe(500);
    expect(shippingGBPPence('kurier')).toBe(1200);
    expect(shippingGBPPence('odbior')).toBe(0);
  });

  it('orderAmountGBPPence sums items + paczkomat shipping', () => {
    expect(orderAmountGBPPence([2200, 5000], 'paczkomat')).toBe(7700); // 2200+5000+500
  });

  it('orderAmountGBPPence handles kurier shipping', () => {
    expect(orderAmountGBPPence([2200], 'kurier')).toBe(3400); // 2200+1200
  });

  it('orderAmountGBPPence handles odbior (free)', () => {
    expect(orderAmountGBPPence([5000], 'odbior')).toBe(5000);
  });
});

describe('EUR pricing helpers', () => {
  const ALL_CATEGORIES: CategorySlug[] = [
    'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
    'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  ];

  it('PRICE_EUR covers every category with a positive value', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(PRICE_EUR[cat]).toBeGreaterThan(0);
    }
  });

  it('shippingEuroCents returns zero for odbior', () => {
    expect(shippingEuroCents('odbior')).toBe(0);
  });

  it('orderAmountEuroCents sums items + paczkomat shipping', () => {
    // kubki=22€, wazony=50€, paczkomat=5€ → (2200+5000)+500 = 7700
    expect(orderAmountEuroCents([2200, 5000], 'paczkomat')).toBe(7700);
  });

  it('SHIPPING_EUR has expected values for all methods', () => {
    expect(SHIPPING_EUR.paczkomat).toBe(5);
    expect(SHIPPING_EUR.kurier).toBe(10);
    expect(SHIPPING_EUR.odbior).toBe(0);
  });

  it('shippingEuroCents returns correct cents for all methods', () => {
    expect(shippingEuroCents('paczkomat')).toBe(500);
    expect(shippingEuroCents('kurier')).toBe(1000);
    expect(shippingEuroCents('odbior')).toBe(0);
  });

  it('orderAmountEuroCents handles kurier shipping', () => {
    expect(orderAmountEuroCents([2200], 'kurier')).toBe(3200); // 2200 + 1000
  });

  it('orderAmountEuroCents handles odbior (free)', () => {
    expect(orderAmountEuroCents([5000], 'odbior')).toBe(5000); // 5000 + 0
  });
});

describe('shippingOfCurrency', () => {
  it('returns the per-currency flat shipping in major units', () => {
    expect(shippingOfCurrency('pln', 'paczkomat')).toBe(20);
    expect(shippingOfCurrency('eur', 'kurier')).toBe(10);
    expect(shippingOfCurrency('gbp', 'kurier')).toBe(12);
    expect(shippingOfCurrency('pln', 'odbior')).toBe(0);
  });
  // Intentional asymmetry: priceOfCurrency THROWS for usd/cad (no price table),
  // so the item price is computed before shipping is ever read — usd/cad never
  // reach shippingOfCurrency in a real flow. Its EUR default is only exercised
  // for the real switchable currencies. This test documents that, it isn't a
  // claim that usd/cad shipping is "supported".
  it('routes non-switchable currencies through the EUR default (unreachable in practice)', () => {
    expect(shippingOfCurrency('usd', 'paczkomat')).toBe(shippingOfCurrency('eur', 'paczkomat'));
  });
});

/** PDP estimated total (item + paczkomat) must match checkout PaymentIntent amount. */
describe('PDP estimate ↔ checkout parity (paczkomat)', () => {
  const product = { category: 'kubki' as CategorySlug, price: PRICE_PLN.kubki };
  const method = 'paczkomat' as const;

  it('PLN minor units match orderAmountGrosze', async () => {
    const cart = await validateCart(['k01'], 'pln');
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const checkoutMinor = orderAmountGrosze(
      cart.items.map((i) => i.unit_price),
      method,
    );
    const pdpMajor = priceOfCurrency(product, 'pln') + shippingOfCurrency('pln', method);
    expect(checkoutMinor).toBe(toMinor(pdpMajor));
  });

  it('EUR minor units match orderAmountEuroCents', async () => {
    const cart = await validateCart(['k01'], 'eur');
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const checkoutMinor = orderAmountEuroCents(
      cart.items.map((i) => i.unit_price),
      method,
    );
    const pdpMajor = priceOfCurrency(product, 'eur') + shippingOfCurrency('eur', method);
    expect(checkoutMinor).toBe(toMinor(pdpMajor));
  });

  it('GBP minor units match orderAmountGBPPence', async () => {
    const cart = await validateCart(['k01'], 'gbp');
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const checkoutMinor = orderAmountGBPPence(
      cart.items.map((i) => i.unit_price),
      method,
    );
    const pdpMajor = priceOfCurrency(product, 'gbp') + shippingOfCurrency('gbp', method);
    expect(checkoutMinor).toBe(toMinor(pdpMajor));
  });
});

describe('priceOfCurrency', () => {
  const product = { category: 'kubki' as CategorySlug, price: PRICE_PLN.kubki };

  it('returns the product PLN price for pln', () => {
    expect(priceOfCurrency(product, 'pln')).toBe(PRICE_PLN.kubki);
  });

  it('returns the GBP table price for gbp', () => {
    expect(priceOfCurrency(product, 'gbp')).toBe(PRICE_GBP.kubki);
  });

  it('returns the EUR table price for eur', () => {
    expect(priceOfCurrency(product, 'eur')).toBe(PRICE_EUR.kubki);
  });

  it('throws for usd because the USD table is still null', () => {
    expect(() => priceOfCurrency(product, 'usd')).toThrow();
  });

  it('throws for cad because the CAD table is still null', () => {
    expect(() => priceOfCurrency(product, 'cad')).toThrow();
  });
});
