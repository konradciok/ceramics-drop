import { describe, expect, it } from 'vitest';
import { COURIER_ENABLED } from '@/lib/pricing';
import { DESTINATION_COUNTRIES, DESTINATIONS, isShippable } from '@/lib/delivery/destinations';
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

      // (A former toContain('1–3') only ever matched the "Nº 01–39" plate title.)
      expect(serialized).not.toContain('3–5');
      expect(serialized).not.toContain('75 zł');
    }
  });

  it('quote the shipping prices through placeholders, never as typed-in amounts', () => {
    // The amounts come from the CMS-published tables (src/lib/shipping-copy.ts),
    // so a /v1/shipping-rates publish cannot leave the shipping page stale.
    for (const messages of [pl, en, es, de]) {
      const { s1P, s1Li1, s1Li1c, s1Li1b } = messages.shipping;
      expect(s1Li1).toContain('{lockerEs}');
      expect(s1Li1c).toContain('{lockerEu}');
      expect(s1Li1b).toContain('{courier}');
      // The courier sentence left the copy with COURIER_ENABLED = false (2026-11-24).
      expect(s1P.includes('{courier}')).toBe(COURIER_ENABLED);
      for (const text of [s1P, s1Li1, s1Li1c, s1Li1b]) {
        expect(text).not.toMatch(/\d+(?:[.,]\d+)?\s?(?:zł|€|£|PLN|EUR|GBP)/);
      }
    }
  });
});

/**
 * How each locale's shipping copy names the countries checkout ships to:
 * `inText` as the prose sentences spell them (Polish locative: "w Hiszpanii"),
 * `inList` as the price list spells them (nominative). A substring match.
 */
const COPY_COUNTRY_NAMES: Record<'pl' | 'en' | 'es' | 'de', Record<string, { inText: string; inList: string }>> = {
  pl: {
    ES: { inText: 'Hiszpanii', inList: 'Hiszpania' }, PT: { inText: 'Portugalii', inList: 'Portugalia' },
    FR: { inText: 'Francji', inList: 'Francja' }, DE: { inText: 'Niemczech', inList: 'Niemcy' },
    BE: { inText: 'Belgii', inList: 'Belgia' }, NL: { inText: 'Holandii', inList: 'Holandia' },
    IT: { inText: 'Włoszech', inList: 'Włochy' }, PL: { inText: 'Polsce', inList: 'Polska' },
  },
  en: {
    ES: { inText: 'Spain', inList: 'Spain' }, PT: { inText: 'Portugal', inList: 'Portugal' },
    FR: { inText: 'France', inList: 'France' }, DE: { inText: 'Germany', inList: 'Germany' },
    BE: { inText: 'Belgium', inList: 'Belgium' }, NL: { inText: 'Netherlands', inList: 'Netherlands' },
    IT: { inText: 'Italy', inList: 'Italy' }, PL: { inText: 'Poland', inList: 'Poland' },
  },
  es: {
    ES: { inText: 'España', inList: 'España' }, PT: { inText: 'Portugal', inList: 'Portugal' },
    FR: { inText: 'Francia', inList: 'Francia' }, DE: { inText: 'Alemania', inList: 'Alemania' },
    BE: { inText: 'Bélgica', inList: 'Bélgica' }, NL: { inText: 'Países Bajos', inList: 'Países Bajos' },
    IT: { inText: 'Italia', inList: 'Italia' }, PL: { inText: 'Polonia', inList: 'Polonia' },
  },
  de: {
    ES: { inText: 'Spanien', inList: 'Spanien' }, PT: { inText: 'Portugal', inList: 'Portugal' },
    FR: { inText: 'Frankreich', inList: 'Frankreich' }, DE: { inText: 'Deutschland', inList: 'Deutschland' },
    BE: { inText: 'Belgien', inList: 'Belgien' }, NL: { inText: 'Niederlande', inList: 'Niederlande' },
    IT: { inText: 'Italien', inList: 'Italien' }, PL: { inText: 'Polen', inList: 'Polen' },
  },
};

/** "eight countries" in deliveryNotice, the home heading and the meta description. */
const COUNTRY_COUNT_WORD: Record<'pl' | 'en' | 'es' | 'de', string> = { pl: 'ośmiu', en: 'eight', es: 'ocho', de: 'acht' };

describe('shipping copy names exactly the countries checkout ships to', () => {
  const shippable = DESTINATION_COUNTRIES.filter((c) => isShippable(DESTINATIONS[c]));
  const locales = { pl, en, es, de } as const;

  it.each(Object.keys(locales) as Array<keyof typeof locales>)('%s', (locale) => {
    const messages = locales[locale];
    const names = COPY_COUNTRY_NAMES[locale];
    // A lane that opens or closes must update this map and the copy together.
    expect(Object.keys(names).sort()).toEqual([...shippable].sort());
    expect(shippable).toHaveLength(8);

    for (const country of shippable) {
      const { inText, inList } = names[country];
      expect(messages.shipping.s1P).toContain(inText);
      expect(messages.home.craft3PShipOnly).toContain(inText);
      // Spain has its own price line; every other country is in the 'eu' line.
      const priceLine = DESTINATIONS[country].zone === 'es' ? messages.shipping.s1Li1 : messages.shipping.s1Li1c;
      expect(priceLine).toContain(inList);
    }
    const count = COUNTRY_COUNT_WORD[locale];
    expect(messages.deliveryNotice.p1).toContain(count);
    expect(messages.home.craft3HShipOnly).toContain(count);
    expect(messages.ceramicShop.metaDescription).toContain(count);
  });
});
