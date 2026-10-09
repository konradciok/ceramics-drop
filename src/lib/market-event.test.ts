import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IMG_WIDTHS } from '@/lib/images';
import { registryProductById } from '@/lib/products';
import {
  MARKET_ENGAGEMENT,
  MARKET_EVENT,
  MARKET_IMAGES,
  MARKET_SHOWROOM_ALT,
  MARKET_SHOWROOM_IDS,
  marketCalendarUrl,
  marketMapsUrl,
  showroomImageSize,
} from './market-event';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function variantsOf(src: string): string[] {
  const dot = src.lastIndexOf('.');
  return [src, ...IMG_WIDTHS.map((w) => `${src.slice(0, dot)}-${w}w${src.slice(dot)}`)];
}

describe('market event links', () => {
  it('points directions at the studio-supplied pin', () => {
    const url = new URL(marketMapsUrl());
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('28.044737720390916,-16.538546894694644');
  });

  it('builds a Google Calendar template for 9:00–14:00 Canary time on 10 Oct 2026', () => {
    const url = new URL(marketCalendarUrl());
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('dates')).toBe('20261010T090000/20261010T140000');
    expect(url.searchParams.get('ctz')).toBe('Atlantic/Canary');
    expect(url.searchParams.get('text')).toBe(MARKET_EVENT.name);
    expect(url.searchParams.get('details')).toContain(marketMapsUrl());
    expect(url.searchParams.get('details')).toContain('Bizum');
  });

  it('keeps engagement types namespaced and unique', () => {
    const types = Object.values(MARKET_ENGAGEMENT);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) expect(type).toMatch(/^market_[a-z_]+$/);
  });
});

describe('market photos', () => {
  it('ships every campaign image with its responsive variants', () => {
    for (const image of Object.values(MARKET_IMAGES)) {
      for (const file of variantsOf(image.src)) {
        expect(fs.existsSync(path.join(PUBLIC_DIR, file)), file).toBe(true);
      }
    }
  });

  it('declares the real pixel size of every campaign image', async () => {
    for (const image of Object.values(MARKET_IMAGES)) {
      const meta = await sharp(path.join(PUBLIC_DIR, image.src)).metadata();
      expect([meta.width, meta.height], image.src).toEqual([image.width, image.height]);
    }
  });

  it('only showcases real registry pieces whose photos exist, at the declared ratio', async () => {
    for (const id of MARKET_SHOWROOM_IDS) {
      const product = registryProductById(id);
      expect(product, id).toBeDefined();
      expect(MARKET_SHOWROOM_ALT[id]).toBeTruthy();
      for (const file of variantsOf(product!.image)) {
        expect(fs.existsSync(path.join(PUBLIC_DIR, file)), file).toBe(true);
      }
      const meta = await sharp(path.join(PUBLIC_DIR, product!.image)).metadata();
      const declared = showroomImageSize(product!.category);
      expect(meta.width! / meta.height!, id).toBeCloseTo(declared.width / declared.height, 2);
    }
  });
});
