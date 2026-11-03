import { beforeEach, describe, expect, it, vi } from 'vitest';

const feed = vi.hoisted(() => ({
  buildFeedItems: vi.fn(async () => [{ id: 'legacy-print' }]),
  buildGoogleFeedItems: vi.fn(async () => [{ id: 'market-print' }]),
  buildGoogleXml: vi.fn(() => '<rss />'),
}));

vi.mock('@/lib/feed', () => ({
  ...feed,
  FEED_LOCALES: ['pl', 'en', 'es', 'de'],
  EU_FEED_LOCALES: ['en', 'es', 'de'],
  isGoogleFeedMarketId: (value: string | null) => value === 'pl' || value === 'gb' || value === 'eu',
}));

const get = async (path: string) => {
  const { GET } = await import('./route');
  return GET(new Request(`http://localhost${path}`));
};

describe('GET /api/feed/google', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps an existing locale-only feed URL working', async () => {
    const response = await get('/api/feed/google?locale=en');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<rss />');
    expect(feed.buildFeedItems).toHaveBeenCalledWith('en');
    expect(feed.buildGoogleFeedItems).not.toHaveBeenCalled();
    expect(feed.buildGoogleXml).toHaveBeenCalledWith([{ id: 'legacy-print' }], 'en');
  });

  it('defaults the no-query legacy feed to Polish', async () => {
    const response = await get('/api/feed/google');
    expect(response.status).toBe(200);
    expect(feed.buildFeedItems).toHaveBeenCalledWith('pl');
  });

  it('validates locales on legacy URLs', async () => {
    const response = await get('/api/feed/google?locale=fr');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_locale' });
    expect(feed.buildFeedItems).not.toHaveBeenCalled();
  });

  it('uses a market feed only when the market is explicitly supplied', async () => {
    const response = await get('/api/feed/google?market=eu&locale=de');
    expect(response.status).toBe(200);
    expect(feed.buildGoogleFeedItems).toHaveBeenCalledWith('eu', 'de');
    expect(feed.buildFeedItems).not.toHaveBeenCalled();
  });
});
