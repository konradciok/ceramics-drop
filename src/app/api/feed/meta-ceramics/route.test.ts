import { beforeEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ items: vi.fn() }));

vi.mock('@/lib/meta-catalog-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/meta-catalog-feed')>();
  return { ...actual, buildMetaFeedItems: build.items };
});
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { GET } from './route';
import { MetaFeedUnavailableError } from '@/lib/meta-catalog-feed';

const req = (query = '') => new Request(`https://anna-ciok.studio/api/feed/meta-ceramics${query}`);

beforeEach(() => {
  build.items.mockReset();
  build.items.mockResolvedValue([]);
});

describe('GET /api/feed/meta-ceramics', () => {
  it('serves the Polish PLN feed by default as uncached XML', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(build.items).toHaveBeenCalledWith('pl', 'pln');
    expect(await res.text()).toContain('<rss');
  });

  it('defaults non-Polish locales to EUR and accepts GBP', async () => {
    await GET(req('?locale=de'));
    expect(build.items).toHaveBeenLastCalledWith('de', 'eur');
    await GET(req('?locale=en&currency=gbp'));
    expect(build.items).toHaveBeenLastCalledWith('en', 'gbp');
  });

  it.each([
    ['?locale=fr', 'invalid_locale'],
    ['?locale=pl&currency=eur', 'invalid_currency'],
    ['?locale=en&currency=pln', 'invalid_currency'],
  ])('rejects %s', async (query, error) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it.each([
    ['availability unknown', new MetaFeedUnavailableError('sale_state')],
    ['an unexpected fault', new Error('boom')],
  ])('answers 503 + Retry-After, never an empty feed, on %s', async (_label, error) => {
    build.items.mockRejectedValue(error);
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(await res.json()).toEqual({ error: 'feed_unavailable' });
  });
});
