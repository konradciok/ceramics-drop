import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IMG_WIDTHS } from '@/lib/images';
import { registryProductById } from '@/lib/products';
import {
  MARKET_DIRECTIONS_EVENT,
  MARKET_ENGAGEMENT,
  MARKET_IMAGES,
  MARKET_SHOWROOM_IDS,
  marketCalendarUrl,
  marketMapsUrl,
  showroomImageSize,
} from './market-event';

const COPY = {
  name: 'Anna Ciok at the El Médano handicraft market',
  place: 'Main plaza, El Médano',
  calendarDetails: 'Hand-painted ceramics. Cash, card or Bizum.',
  mapLabel: 'Map',
};

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function variantsOf(src: string): string[] {
  const dot = src.lastIndexOf('.');
  return [src, ...IMG_WIDTHS.map((w) => `${src.slice(0, dot)}-${w}w${src.slice(dot)}`)];
}

describe('market event links', () => {
  it('points directions at the studio-supplied Google Maps link', () => {
    expect(marketMapsUrl()).toBe('https://maps.app.goo.gl/U5MMXTApFgmbyVadA');
  });

  it('builds a Google Calendar template for 9:00–14:00 Canary time on 10 Oct 2026', () => {
    const url = new URL(marketCalendarUrl(COPY));
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('dates')).toBe('20261010T090000/20261010T140000');
    expect(url.searchParams.get('ctz')).toBe('Atlantic/Canary');
    expect(url.searchParams.get('text')).toBe(COPY.name);
    expect(url.searchParams.get('details')).toContain(marketMapsUrl());
    expect(url.searchParams.get('details')).toContain('Bizum');
  });

  it('keeps the directions conversion out of site_engagement', () => {
    expect(MARKET_DIRECTIONS_EVENT).toBe('market_get_directions');
    expect(Object.values(MARKET_ENGAGEMENT)).not.toContain(MARKET_DIRECTIONS_EVENT);
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
      for (const file of variantsOf(product!.image)) {
        expect(fs.existsSync(path.join(PUBLIC_DIR, file)), file).toBe(true);
      }
      const meta = await sharp(path.join(PUBLIC_DIR, product!.image)).metadata();
      const declared = showroomImageSize(product!.category);
      expect(meta.width! / meta.height!, id).toBeCloseTo(declared.width / declared.height, 2);
    }
  });
});
