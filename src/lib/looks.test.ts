import { describe, it, expect } from 'vitest';
import { LOOKS, type Localized } from './looks';
import { getProductById } from './products';
import { routing } from '@/i18n/routing';

/** Assert a Localized field has a non-empty string for every configured locale. */
function expectComplete(value: Localized, ctx: string) {
  for (const locale of routing.locales) {
    expect(value?.[locale], `${ctx} missing/empty for locale "${locale}"`).toBeTruthy();
  }
}

describe('LOOKS', () => {
  it('all look ids are unique', () => {
    const ids = LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every look has at least one marker', () => {
    for (const look of LOOKS) {
      expect(look.markers.length, `look "${look.id}" has no markers`).toBeGreaterThan(0);
    }
  });

  it('every look image is a /uploads webp path', () => {
    for (const look of LOOKS) {
      expect(look.image, `look "${look.id}" image`).toMatch(/^\/uploads\/.+\.webp$/);
    }
  });

  it('look title / editorial / imageAlt are localized for all locales', () => {
    for (const look of LOOKS) {
      expectComplete(look.title, `look "${look.id}" title`);
      expectComplete(look.editorial, `look "${look.id}" editorial`);
      expectComplete(look.imageAlt, `look "${look.id}" imageAlt`);
    }
  });

  it('marker labels are localized for all locales', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expectComplete(marker.label, `look "${look.id}" marker ${marker.num} label`);
      }
    }
  });

  it('all marker productIds resolve via getProductById', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expect(
          getProductById(marker.productId),
          `productId "${marker.productId}" in look "${look.id}" not found`,
        ).toBeDefined();
      }
    }
  });

  it('all marker coordinates are within [0, 100]', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expect(marker.x, `look ${look.id} marker ${marker.num} x`).toBeGreaterThanOrEqual(0);
        expect(marker.x, `look ${look.id} marker ${marker.num} x`).toBeLessThanOrEqual(100);
        expect(marker.y, `look ${look.id} marker ${marker.num} y`).toBeGreaterThanOrEqual(0);
        expect(marker.y, `look ${look.id} marker ${marker.num} y`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('marker nums are exactly 1..N (sequential, no gaps or dupes)', () => {
    for (const look of LOOKS) {
      const nums = look.markers.map((m) => m.num).sort((a, b) => a - b);
      const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
      expect(nums, `look "${look.id}" marker nums must be 1..${nums.length}`).toEqual(expected);
    }
  });
});
