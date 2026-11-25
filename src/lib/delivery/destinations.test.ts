import { describe, it, expect, vi } from 'vitest';
import {
  DESTINATIONS,
  DESTINATION_COUNTRIES,
  PRIMARY_DESTINATION_COUNTRY,
  checkoutCountries,
  defaultCheckoutCountry,
  destinationFor,
  isDestinationCountry,
  isShippable,
} from './destinations';

describe('destination registry', () => {
  it('covers the ten owner-approved countries, Spain in its own price zone', () => {
    expect([...DESTINATION_COUNTRIES].sort()).toEqual(['AT', 'BE', 'DE', 'ES', 'FR', 'IT', 'LU', 'NL', 'PL', 'PT']);
    expect(DESTINATIONS.ES.zone).toBe('es');
    expect(DESTINATIONS.ES.transitDays).toBe(4);
    for (const c of DESTINATION_COUNTRIES.filter((c) => c !== 'ES')) expect(DESTINATIONS[c].zone).toBe('eu');
    for (const c of DESTINATION_COUNTRIES) expect(DESTINATIONS[c].country).toBe(c);
  });

  it('keeps Poland on ShipX and ships every other country through Sendcloud', () => {
    expect(DESTINATIONS.PL.channel).toBe('inpost_shipx');
    expect(DESTINATIONS.PL.sendcloudShippingOption).toBeNull();
    for (const c of DESTINATION_COUNTRIES.filter((c) => c !== 'PL')) {
      expect(DESTINATIONS[c].channel).toBe('sendcloud');
      expect(DESTINATIONS[c].sendcloudCarrier).toBe('inpost_es');
    }
  });

  it('carries the InPost ES codes verified on 2026-11-24, and none for AT or LU', () => {
    expect(DESTINATIONS.ES.sendcloudShippingOption).toBe('inpost_es:service_point,national_c2c');
    for (const c of ['PT', 'FR', 'DE', 'BE', 'NL', 'IT'] as const) {
      expect(DESTINATIONS[c].sendcloudShippingOption).toBe('inpost_es:service_point,international_c2c');
    }
    expect(DESTINATIONS.AT.sendcloudShippingOption).toBeNull();
    expect(DESTINATIONS.LU.sendcloudShippingOption).toBeNull();
    expect(isShippable(DESTINATIONS.AT)).toBe(false);
    expect(isShippable(DESTINATIONS.PL)).toBe(true);
  });

  it('offers only Poland until the multi-country copy ships', () => {
    for (const c of DESTINATION_COUNTRIES) expect(DESTINATIONS[c].enabled).toBe(c === 'PL');
  });

  it('looks countries up strictly', () => {
    expect(isDestinationCountry('ES')).toBe(true);
    expect(isDestinationCountry('es')).toBe(false);
    expect(isDestinationCountry('GB')).toBe(false);
    expect(destinationFor('PT')?.zone).toBe('eu');
    expect(destinationFor('IC')).toBeNull();
    expect(destinationFor(null)).toBeNull();
  });
});

describe('checkoutCountries', () => {
  it('follows the enabled flags without an override', () => {
    // `undefined` falls through to process.env.CHECKOUT_COUNTRIES: pin it empty.
    vi.stubEnv('CHECKOUT_COUNTRIES', '');
    try {
      expect(checkoutCountries('')).toEqual(['PL']);
      expect(checkoutCountries(undefined)).toEqual(['PL']);
      expect(checkoutCountries()).toEqual(['PL']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets CHECKOUT_COUNTRIES replace the flags, in registry order, case-insensitively', () => {
    expect(checkoutCountries('pl, de ,ES')).toEqual(['ES', 'DE', 'PL']);
    expect(checkoutCountries('ES')).toEqual(['ES']);
  });

  it('never offers a lane without a verified shipping option, nor an unknown country', () => {
    expect(checkoutCountries('ES,AT,LU,GB')).toEqual(['ES']);
  });

  it('falls back to the flags when the override names nothing usable', () => {
    expect(checkoutCountries('AT,GB')).toEqual(['PL']);
  });
});

describe('defaultCheckoutCountry', () => {
  const countries = ['ES', 'DE', 'PL'] as const;

  it("prefers the visitor's country when checkout ships there", () => {
    expect(defaultCheckoutCountry(countries, { ipCountry: 'de', locale: 'pl' })).toBe('DE');
  });

  it('otherwise picks by locale (en → Spain)', () => {
    expect(defaultCheckoutCountry(countries, { ipCountry: 'GB', locale: 'pl' })).toBe('PL');
    expect(defaultCheckoutCountry(countries, { ipCountry: null, locale: 'en' })).toBe('ES');
    expect(defaultCheckoutCountry(countries, { locale: 'es' })).toBe('ES');
  });

  it('falls back to the first offered country', () => {
    expect(defaultCheckoutCountry(['PL'], { ipCountry: 'ES', locale: 'en' })).toBe('PL');
    expect(defaultCheckoutCountry(['DE', 'PL'], { locale: 'es' })).toBe('DE');
  });

  it('keeps Poland as the primary destination', () => {
    expect(PRIMARY_DESTINATION_COUNTRY).toBe('PL');
  });
});
