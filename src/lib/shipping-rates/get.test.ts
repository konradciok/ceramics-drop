import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { getShippingRatesForCheckout } from './get';
import { loadShippingRatesFromDb } from './load';
import { CODE_SHIPPING_RATES, resetLastKnownGoodForTests } from './last-known-good';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '../print-shipping';

vi.mock('./load', () => ({ loadShippingRatesFromDb: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const DB_RATES = {
  domestic: {
    pln: { paczkomat: 22, kurier: 33, odbior: 0 },
    eur: { paczkomat: 6, kurier: 11, odbior: 0 },
    gbp: { paczkomat: 6, kurier: 13, odbior: 0 },
  },
  international: { ...DEFAULT_INTERNATIONAL_SHIPPING, PL: { framed: 19.99, loose: 11.11 } },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetLastKnownGoodForTests();
});

describe('getShippingRatesForCheckout', () => {
  it('returns the code constants in code mode without touching the DB', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'code');
    await expect(getShippingRatesForCheckout()).resolves.toBe(CODE_SHIPPING_RATES);
    expect(loadShippingRatesFromDb).not.toHaveBeenCalled();
  });

  it('returns the published DB rates in db mode', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadShippingRatesFromDb).mockResolvedValue(DB_RATES);
    await expect(getShippingRatesForCheckout()).resolves.toEqual(DB_RATES);
  });

  it('on a cold isolate, a DB outage degrades to the code constants — checkout never fails closed on shipping', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadShippingRatesFromDb).mockRejectedValue(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getShippingRatesForCheckout()).resolves.toBe(CODE_SHIPPING_RATES);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { supabaseTimeoutLabel: 'shipping-rates-checkout', fallbackTier: 'code-default' } }),
    );
    errSpy.mockRestore();
  });

  it('after a prior successful read, a later failure returns that last-known-good table (not the constants)', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadShippingRatesFromDb).mockResolvedValueOnce(DB_RATES);
    await getShippingRatesForCheckout();

    vi.mocked(loadShippingRatesFromDb).mockRejectedValueOnce(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getShippingRatesForCheckout()).resolves.toEqual(DB_RATES);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { supabaseTimeoutLabel: 'shipping-rates-checkout', fallbackTier: 'last-known-good' } }),
    );
    errSpy.mockRestore();
  });

  it('never throws, for either track', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadShippingRatesFromDb).mockRejectedValue(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rates = await getShippingRatesForCheckout();
    expect(rates.domestic.pln.kurier).toBe(30);
    expect(rates.international.DE.loose).toBe(7.3);
    errSpy.mockRestore();
  });
});
