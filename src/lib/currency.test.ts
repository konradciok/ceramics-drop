import { describe, it, expect } from 'vitest';
import {
  currencyForCountry,
  parseCurrency,
  defaultCurrencyForLocale,
  currencyFromCookieHeader,
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

describe('currencyFromCookieHeader', () => {
  it('reads a switchable gbp cookie', () => {
    expect(currencyFromCookieHeader('en', 'currency_pref=gbp')).toBe('gbp');
  });

  it('reads a switchable eur cookie', () => {
    expect(currencyFromCookieHeader('en', 'currency_pref=eur')).toBe('eur');
  });

  it('falls back to eur for a non-switchable usd cookie', () => {
    expect(currencyFromCookieHeader('en', 'currency_pref=usd')).toBe('eur');
  });

  it('falls back to eur for a pln cookie on a non-pl locale', () => {
    expect(currencyFromCookieHeader('en', 'currency_pref=pln')).toBe('eur');
  });

  it('parses the cookie among other cookies', () => {
    expect(currencyFromCookieHeader('en', 'x=1; currency_pref=gbp; y=2')).toBe('gbp');
  });

  it('defaults to eur when the cookie header is missing or empty', () => {
    expect(currencyFromCookieHeader('en', null)).toBe('eur');
    expect(currencyFromCookieHeader('en', '')).toBe('eur');
  });

  it('forces pln for the pl locale regardless of cookie', () => {
    expect(currencyFromCookieHeader('pl', 'currency_pref=gbp')).toBe('pln');
  });
});
