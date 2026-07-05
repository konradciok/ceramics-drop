import { describe, it, expect } from 'vitest';
import {
  currencyForCountry,
  parseCurrency,
  defaultCurrencyForLocale,
} from './currency';

describe('currencyForCountry', () => {
  it('maps GB to gbp', () => {
    expect(currencyForCountry('GB')).toBe('gbp');
  });

  it('maps an unmapped country (DE) to the eur default', () => {
    expect(currencyForCountry('DE')).toBe('eur');
  });

  it('defaults null/absent country to eur', () => {
    expect(currencyForCountry(null)).toBe('eur');
    expect(currencyForCountry(undefined)).toBe('eur');
  });

  it('is case-insensitive on the country code', () => {
    expect(currencyForCountry('gb')).toBe('gbp');
  });
});

describe('parseCurrency', () => {
  it('accepts a known currency code', () => {
    expect(parseCurrency('gbp')).toBe('gbp');
  });

  it('returns null for an unknown code', () => {
    expect(parseCurrency('xxx')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(parseCurrency(null)).toBeNull();
    expect(parseCurrency(undefined)).toBeNull();
    expect(parseCurrency('')).toBeNull();
  });
});

describe('defaultCurrencyForLocale', () => {
  it('pl defaults to pln', () => {
    expect(defaultCurrencyForLocale('pl')).toBe('pln');
  });

  it('non-pl locales default to eur', () => {
    expect(defaultCurrencyForLocale('en')).toBe('eur');
    expect(defaultCurrencyForLocale('es')).toBe('eur');
    expect(defaultCurrencyForLocale('de')).toBe('eur');
  });
});
