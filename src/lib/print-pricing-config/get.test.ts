import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { DEFAULT_PRINT_PRICING } from '../print-pricing';
import { getPrintPricingConfig, getPrintPricingConfigForCheckout, PrintPricingUnavailableError } from './get';
import { loadPrintPricingConfigFromDb } from './load';
import { resetLastKnownGoodForTests } from './last-known-good';

vi.mock('./load', () => ({
  loadPrintPricingConfigFromDb: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

const DB_CONFIG = {
  ...DEFAULT_PRINT_PRICING,
  baseEur: { '30x40': 30, '50x70': 60, '70x100': 90 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetLastKnownGoodForTests();
});

describe('getPrintPricingConfig', () => {
  it('returns the code default in code mode without touching the DB', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'code');
    await expect(getPrintPricingConfig()).resolves.toEqual(DEFAULT_PRINT_PRICING);
    expect(loadPrintPricingConfigFromDb).not.toHaveBeenCalled();
  });

  it('returns the DB config in db mode', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadPrintPricingConfigFromDb).mockResolvedValue(DB_CONFIG);
    await expect(getPrintPricingConfig()).resolves.toEqual(DB_CONFIG);
  });

  it('falls back to the code default when the DB read fails (no throw)', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadPrintPricingConfigFromDb).mockRejectedValue(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getPrintPricingConfig()).resolves.toEqual(DEFAULT_PRINT_PRICING);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('getPrintPricingConfigForCheckout', () => {
  it('returns the code default in code mode without touching the DB', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'code');
    await expect(getPrintPricingConfigForCheckout()).resolves.toEqual(DEFAULT_PRINT_PRICING);
    expect(loadPrintPricingConfigFromDb).not.toHaveBeenCalled();
  });

  it('returns the DB config in db mode', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadPrintPricingConfigFromDb).mockResolvedValue(DB_CONFIG);
    await expect(getPrintPricingConfigForCheckout()).resolves.toEqual(DB_CONFIG);
  });

  it('on a cold isolate (no prior success), throws PrintPricingUnavailableError rather than returning DEFAULT_PRINT_PRICING', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadPrintPricingConfigFromDb).mockRejectedValue(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getPrintPricingConfigForCheckout()).rejects.toBeInstanceOf(PrintPricingUnavailableError);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { supabaseTimeoutLabel: 'print-pricing-config-checkout', fallbackTier: 'cold-fail-closed' } }),
    );
    errSpy.mockRestore();
  });

  it('after a prior successful read in this isolate, a later failure returns that last-known-good config (not the hardcoded default)', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    vi.mocked(loadPrintPricingConfigFromDb).mockResolvedValueOnce(DB_CONFIG);
    await getPrintPricingConfigForCheckout();

    vi.mocked(loadPrintPricingConfigFromDb).mockRejectedValueOnce(new Error('supabase down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getPrintPricingConfigForCheckout()).resolves.toEqual(DB_CONFIG);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { supabaseTimeoutLabel: 'print-pricing-config-checkout', fallbackTier: 'last-known-good' } }),
    );
    errSpy.mockRestore();
  });
});
