import { describe, expect, it } from 'vitest';
import pl from '../../messages/pl.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import de from '../../messages/de.json';
import gb from '../../messages/gb.json';
import { SHIPPING_PLN, SHIPPING_EUR, SHIPPING_GBP } from '@/lib/pricing';
import { pln } from '@/lib/format';

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
    expect(shape(gb)).toEqual(referenceShape);
  });

  it('keep current shipping timing and courier pricing in public copy', () => {
    // pl/en/es shipping pages reference PLN prices (en.json keeps zł for consistency with the Polish market)
    for (const messages of [pl, en, es]) {
      const serialized = JSON.stringify(messages);

      expect(serialized).toContain('1–3');
      expect(serialized).not.toContain('3–5');
      expect(serialized).not.toContain('75 zł');
      expect(serialized).toContain(pln(SHIPPING_PLN.kurier));
      expect(serialized).toContain(pln(SHIPPING_PLN.paczkomat));
    }
  });

  it('de locale references EUR shipping prices', () => {
    const serialized = JSON.stringify(de);
    expect(serialized).toContain('1–3');
    expect(serialized).toContain(`${SHIPPING_EUR.kurier} €`);
    expect(serialized).toContain(`${SHIPPING_EUR.paczkomat} €`);
  });

  it('gb locale references GBP shipping prices', () => {
    const serialized = JSON.stringify(gb);
    expect(serialized).toContain('1–3');
    expect(serialized).toContain(`£${SHIPPING_GBP.kurier}`);
    expect(serialized).toContain(`£${SHIPPING_GBP.paczkomat}`);
  });
});
