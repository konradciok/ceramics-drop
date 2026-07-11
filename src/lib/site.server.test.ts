import { describe, it, expect } from 'vitest';
import { getWorkerOrigin } from './site.server';
import { SITE_URL } from './site';

describe('getWorkerOrigin', () => {
  it('falls back to SITE_URL when WORKER_ORIGIN is unset', () => {
    expect(getWorkerOrigin({})).toBe(SITE_URL);
  });

  it('falls back to SITE_URL when WORKER_ORIGIN is empty or whitespace', () => {
    expect(getWorkerOrigin({ WORKER_ORIGIN: '' })).toBe(SITE_URL);
    expect(getWorkerOrigin({ WORKER_ORIGIN: '   ' })).toBe(SITE_URL);
  });

  it('uses WORKER_ORIGIN when set', () => {
    expect(getWorkerOrigin({ WORKER_ORIGIN: 'https://staging.anna-ciok.studio' })).toBe(
      'https://staging.anna-ciok.studio',
    );
  });

  it('strips trailing slashes to avoid double-slash URLs', () => {
    expect(getWorkerOrigin({ WORKER_ORIGIN: 'https://staging.anna-ciok.studio/' })).toBe(
      'https://staging.anna-ciok.studio',
    );
    expect(getWorkerOrigin({ WORKER_ORIGIN: 'https://staging.anna-ciok.studio///' })).toBe(
      'https://staging.anna-ciok.studio',
    );
  });

  it('falls back to SITE_URL when WORKER_ORIGIN is only slashes', () => {
    expect(getWorkerOrigin({ WORKER_ORIGIN: '/' })).toBe(SITE_URL);
  });
});
