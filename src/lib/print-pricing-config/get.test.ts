import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT_PRICING } from '../print-pricing';
import { getPrintPricingConfig } from './get';
import { loadPrintPricingConfigFromDb } from './load';

vi.mock('./load', () => ({
  loadPrintPricingConfigFromDb: vi.fn(),
}));

const DB_CONFIG = {
  ...DEFAULT_PRINT_PRICING,
  baseEur: { '30x40': 30, '50x70': 60, '70x100': 90 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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
