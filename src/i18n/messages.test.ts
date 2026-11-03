import { describe, expect, it } from 'vitest';
import pl from '../../messages/pl.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import de from '../../messages/de.json';

type MessageTree = Record<string, unknown>;

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as MessageTree).map(([key, child]) => [key, shape(child)]),
    );
  }
  return typeof value;
}

describe('locale message files', () => {
  it('keep the same key and type shape across supported locales', () => {
    const referenceShape = shape(pl);

    expect(shape(en)).toEqual(referenceShape);
    expect(shape(es)).toEqual(referenceShape);
    expect(shape(de)).toEqual(referenceShape);
  });

  it('keep current shipping timing in public copy', () => {
    for (const messages of [pl, en, es, de]) {
      const serialized = JSON.stringify(messages);

      expect(serialized).toContain('1–3');
      expect(serialized).not.toContain('3–5');
      expect(serialized).not.toContain('75 zł');
    }
  });

  it('quote the InPost shipping prices through {locker}/{courier}, never as typed-in amounts', () => {
    // The amounts come from the CMS-published table (src/lib/shipping-copy.ts),
    // so a /v1/shipping-rates publish cannot leave the shipping page stale.
    for (const messages of [pl, en, es, de]) {
      const { s1P, s1Li1, s1Li1b } = messages.shipping;
      expect(s1P).toContain('{locker}');
      expect(s1P).toContain('{courier}');
      expect(s1Li1).toContain('{locker}');
      expect(s1Li1b).toContain('{courier}');
      for (const text of [s1P, s1Li1, s1Li1b]) {
        expect(text).not.toMatch(/\d+(?:[.,]\d+)?\s?(?:zł|€|£|PLN|EUR|GBP)/);
      }
    }
  });
});
