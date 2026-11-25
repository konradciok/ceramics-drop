import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CeramicSaleState } from './ceramic-sale-state';

const saleState = vi.hoisted(() => ({ current: null as CeramicSaleState | null }));
const degradation = vi.hoisted(() => ({ coldFailClosed: false }));

vi.mock('./request-degradation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request-degradation')>();
  return { ...actual, isCeramicCatalogColdFailClosed: () => degradation.coldFailClosed };
});

vi.mock('./ceramic-sale-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ceramic-sale-state')>();
  return { ...actual, getCeramicSaleState: vi.fn(async () => saleState.current) };
});
// CMS reads hit Supabase; force the committed-notes fallback path.
vi.mock('./cms/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cms/messages')>();
  return { ...actual, getProductNotes: vi.fn(async () => { throw new Error('no db in tests'); }) };
});

import {
  buildMetaFeedItem,
  buildMetaFeedItems,
  buildMetaFeedXml,
  feedImageUrl,
  MetaFeedUnavailableError,
  priceBand,
  resolveMetaFeedCurrency,
} from './meta-catalog-feed';
import { fallbackProductNotes } from './cms/messages';
import { registryProducts } from './products';

const ACTIVE_DROP = 'drop-2';

function stateWith(overrides: Record<string, Partial<CeramicSaleState['pieces'][number]>> = {}): CeramicSaleState {
  const products = registryProducts();
  return {
    pieces: products.map((p) => ({
      product_id: p.id,
      status: 'available',
      showroom: false,
      reserved_until: null,
      ...overrides[p.id],
    })),
    drops: [...new Set(products.map((p) => p.dropId))].map((id) => ({
      id,
      label: id,
      status: id === ACTIVE_DROP ? 'active' : 'ended',
    })),
    failed: false,
  };
}

const activeDropIds = () => registryProducts().filter((p) => p.dropId === ACTIVE_DROP).map((p) => p.id);

beforeEach(() => {
  saleState.current = stateWith();
  degradation.coldFailClosed = false;
});

describe('resolveMetaFeedCurrency', () => {
  it('prices Polish copy in PLN only', () => {
    expect(resolveMetaFeedCurrency('pl', null)).toBe('pln');
    expect(resolveMetaFeedCurrency('pl', 'pln')).toBe('pln');
    expect(resolveMetaFeedCurrency('pl', 'eur')).toBeNull();
  });

  it('prices other locales in EUR by default, GBP on request, never PLN', () => {
    expect(resolveMetaFeedCurrency('en', null)).toBe('eur');
    expect(resolveMetaFeedCurrency('en', 'gbp')).toBe('gbp');
    expect(resolveMetaFeedCurrency('de', 'eur')).toBe('eur');
    expect(resolveMetaFeedCurrency('es', 'pln')).toBeNull();
    expect(resolveMetaFeedCurrency('en', 'usd')).toBeNull();
  });
});

describe('feedImageUrl', () => {
  it('maps a product WebP to its square feed JPEG', () => {
    expect(feedImageUrl('/uploads/kubek-3.webp')).toBe('https://anna-ciok.studio/uploads/feed/kubek-3.jpg');
  });

  it('refuses non-upload images (Meta cannot ingest them)', () => {
    expect(feedImageUrl('/api/media/site-media/x.webp')).toBeNull();
    expect(feedImageUrl('/uploads/kubek-3.png')).toBeNull();
  });

  it('has a committed feed JPEG for every registry image', () => {
    const missing = registryProducts()
      .flatMap((p) => [p.image, ...(p.gallery ?? [])])
      .filter((image) => {
        const url = feedImageUrl(image);
        if (!url) return true;
        const file = path.join(process.cwd(), 'public', new URL(url).pathname);
        return !fs.existsSync(file);
      });
    // Fix: node scripts/optimize-images.mjs --feed-jpeg
    expect(missing).toEqual([]);
  });
});

describe('priceBand', () => {
  it('buckets PLN prices for product sets', () => {
    expect(priceBand(150)).toBe('price_under_200_pln');
    expect(priceBand(200)).toBe('price_200_399_pln');
    expect(priceBand(699)).toBe('price_400_699_pln');
    expect(priceBand(900)).toBe('price_700_plus_pln');
  });
});

describe('buildMetaFeedItems', () => {
  it('lists only pieces on sale now: active drop, not sold, reserved or in the showroom', async () => {
    const [sold, reserved, showroom, expiredHold, ...rest] = activeDropIds();
    saleState.current = stateWith({
      [sold]: { status: 'sold' },
      [reserved]: { status: 'reserved', reserved_until: new Date(Date.now() + 10 * 60_000).toISOString() },
      [showroom]: { showroom: true },
      [expiredHold]: { status: 'reserved', reserved_until: new Date(Date.now() - 60_000).toISOString() },
    });

    const ids = (await buildMetaFeedItems('pl', 'pln')).map((item) => item.id);

    expect(ids).not.toContain(sold);
    expect(ids).not.toContain(reserved);
    expect(ids).not.toContain(showroom);
    expect(ids).toContain(expiredHold);
    expect(new Set(ids)).toEqual(new Set([expiredHold, ...rest]));
    // Ended-drop (showroom archive) pieces are never advertised.
    expect(registryProducts().filter((p) => p.dropId !== ACTIVE_DROP).some((p) => ids.includes(p.id))).toBe(false);
  });

  it('fails closed instead of emitting an empty feed when availability is unknown', async () => {
    saleState.current = { pieces: [], drops: [], failed: true };
    await expect(buildMetaFeedItems('pl', 'pln')).rejects.toBeInstanceOf(MetaFeedUnavailableError);
  });

  it('fails closed when the cold-fail-closed catalogue was served', async () => {
    degradation.coldFailClosed = true;
    await expect(buildMetaFeedItems('pl', 'pln')).rejects.toBeInstanceOf(MetaFeedUnavailableError);
  });

  it('returns an empty list when a readable catalogue has nothing on sale (withdrawn, not unknown)', async () => {
    saleState.current = stateWith(Object.fromEntries(registryProducts().map((p) => [p.id, { showroom: true }])));
    await expect(buildMetaFeedItems('pl', 'pln')).resolves.toEqual([]);
  });

  it('returns an empty list (not an error) when the live drop is sold out', async () => {
    saleState.current = stateWith(Object.fromEntries(activeDropIds().map((id) => [id, { status: 'sold' }])));
    await expect(buildMetaFeedItems('pl', 'pln')).resolves.toEqual([]);
  });
});

describe('buildMetaFeedItem', () => {
  const product = registryProducts().find((p) => p.category === 'kubki' && p.dropId === ACTIVE_DROP)!;

  it('carries the Pixel content id, localized copy, pinned currency and the PLN price', () => {
    const note = fallbackProductNotes('kubki', 'pl')[product.id];
    const item = buildMetaFeedItem(product, 'pl', 'pln', note)!;

    expect(item.id).toBe(product.id);
    expect(item.title).toBe(`Kubek Nº ${product.num} – ręcznie malowana ceramika, unikat`);
    expect(item.description.startsWith(note.trim())).toBe(true);
    expect(item.description).toContain(`Wymiary: ${product.measure}.`);
    expect(item.link).toBe(`https://anna-ciok.studio/kubki/${product.id}?currency=pln`);
    expect(item.price).toBe(`${product.price.toFixed(2)} PLN`);
    expect(item.googleProductCategory).toBe('2169');
    expect(item.productType).toBe('Ceramika > Kubki');
    expect(item.customLabels).toEqual(['kubki', priceBand(product.price), ACTIVE_DROP, 'one_of_a_kind']);
  });

  it('links the locale-prefixed PDP and prices in the requested currency', () => {
    const item = buildMetaFeedItem(product, 'en', 'gbp', '')!;
    expect(item.link).toBe(`https://anna-ciok.studio/en/kubki/${product.id}?currency=gbp`);
    expect(item.price).toMatch(/^\d+\.00 GBP$/);
    expect(item.title).toContain('hand-painted ceramic, one of a kind');
  });

  it('prefers the CMS-authored description over the note', () => {
    const item = buildMetaFeedItem({ ...product, description: 'Opis z CMS' }, 'pl', 'pln', 'notatka')!;
    expect(item.description.startsWith('Opis z CMS')).toBe(true);
  });

  it('drops a piece whose image Meta cannot ingest', () => {
    expect(buildMetaFeedItem({ ...product, image: '/api/media/x.webp' }, 'pl', 'pln', '')).toBeNull();
  });
});

describe('buildMetaFeedXml', () => {
  it('escapes copy and emits the Meta fields', () => {
    const product = registryProducts().find((p) => p.dropId === ACTIVE_DROP)!;
    const item = buildMetaFeedItem({ ...product, description: 'Kubek <dla> "Ani" & Co' }, 'pl', 'pln', '')!;
    const xml = buildMetaFeedXml([item], 'pl');

    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain('Kubek &lt;dla&gt; &quot;Ani&quot; &amp; Co');
    expect(xml).toContain(`<g:id>${product.id}</g:id>`);
    expect(xml).toContain('<g:availability>in stock</g:availability>');
    expect(xml).toContain('<g:condition>new</g:condition>');
    expect(xml).toContain('<g:brand>Anna Ciok Studio</g:brand>');
    expect(xml).toContain('<g:custom_label_3>one_of_a_kind</g:custom_label_3>');
    expect(xml).not.toContain('.webp');
  });
});
