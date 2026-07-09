import { describe, it, expect } from 'vitest';
import { buildFeedItems, buildGoogleXml, buildMetaXml, type FeedItem } from './feed';

describe('buildFeedItems', () => {
  it('marks sold products as out of stock and others as in stock', () => {
    const items = buildFeedItems('pl', new Set(['k01']));
    const sold = items.find((i) => i.id === 'k01');
    const available = items.find((i) => i.id !== 'k01');
    expect(sold?.availability).toBe('out of stock');
    expect(available?.availability).toBe('in stock');
  });

  it('marks showroom products as out of stock (not advertised as buyable)', () => {
    const items = buildFeedItems('pl', new Set(), new Set(['k02']));
    const showroom = items.find((i) => i.id === 'k02');
    const available = items.find((i) => i.id !== 'k02');
    expect(showroom?.availability).toBe('out of stock');
    expect(available?.availability).toBe('in stock');
  });

  it('formats PLN prices with PLN currency', () => {
    const items = buildFeedItems('pl', new Set());
    const kubek = items.find((i) => i.category === 'kubki');
    expect(kubek?.price).toMatch(/^\d+\.00 PLN$/);
  });

  it('formats EUR prices with EUR currency for en locale', () => {
    const items = buildFeedItems('en', new Set());
    const kubek = items.find((i) => i.category === 'kubki');
    expect(kubek?.price).toMatch(/^\d+\.00 EUR$/);
  });

  it('uses German product names for de locale', () => {
    const items = buildFeedItems('de', new Set());
    const kubek = items.find((i) => i.category === 'kubki');
    expect(kubek?.title).toMatch(/^Tasse #\d+$/);
  });
});

describe('buildGoogleXml', () => {
  const sampleItem: FeedItem = {
    id: 'test-1',
    title: 'Mug & More #1',
    description: 'A <fine> piece "with" special & chars.',
    link: 'https://anna-ciok.studio/en/kubki/test-1',
    imageLink: 'https://anna-ciok.studio/uploads/test.webp',
    additionalImages: [],
    availability: 'in stock',
    price: '25.00 EUR',
    category: 'kubki',
    material: 'Ceramics',
    productType: 'Ceramics > Mug',
    customLabel0: 'standard',
    customLabel1: 'tableware',
    customLabel2: 'kubki',
    shipping: [
      { country: 'IE', service: 'InPost Paczkomat', price: '5.00 EUR' },
      { country: 'IE', service: 'InPost Kurier', price: '10.00 EUR' },
    ],
  };

  it('escapes XML special characters in title and description', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain('Mug &amp; More #1');
    expect(xml).toContain('&lt;fine&gt;');
    expect(xml).toContain('&amp; chars');
    expect(xml).toContain('&quot;with&quot;');
  });

  it('includes g:identifier_exists=no for handmade pieces', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('includes g:google_product_category', () => {
    const xml = buildGoogleXml([sampleItem], 'en');
    expect(xml).toContain('<g:google_product_category>');
  });

  it('includes out of stock availability in the XML output', () => {
    const soldItem: FeedItem = { ...sampleItem, availability: 'out of stock' };
    const xml = buildGoogleXml([soldItem], 'en');
    expect(xml).toContain('<g:availability>out of stock</g:availability>');
  });
});

describe('buildMetaXml', () => {
  const sampleItem: FeedItem = {
    id: 'test-2',
    title: 'Vase #5',
    description: 'A unique vase.',
    link: 'https://anna-ciok.studio/en/wazony/test-2',
    imageLink: 'https://anna-ciok.studio/uploads/vase.webp',
    additionalImages: ['https://anna-ciok.studio/uploads/vase-2.webp'],
    availability: 'in stock',
    price: '58.00 EUR',
    category: 'wazony',
    material: 'Ceramics',
    productType: 'Ceramics > Vase',
    customLabel0: 'premium',
    customLabel1: 'vessels',
    customLabel2: 'wazony',
    shipping: [],
  };

  it('includes g:identifier_exists=no for handmade pieces', () => {
    const xml = buildMetaXml([sampleItem], 'en');
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('includes g:additional_image_link for gallery images', () => {
    const xml = buildMetaXml([sampleItem], 'en');
    expect(xml).toContain('<g:additional_image_link>https://anna-ciok.studio/uploads/vase-2.webp</g:additional_image_link>');
  });

  it('includes g:google_product_category', () => {
    const xml = buildMetaXml([sampleItem], 'en');
    expect(xml).toContain('<g:google_product_category>');
  });
});
