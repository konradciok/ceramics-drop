import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAutocompleteRequest, nextSessionToken, parseAddressComponents } from './google-places';

type FakeComponent = {
  longText: string | null;
  shortText: string | null;
  types: string[];
};

function component(
  types: string[],
  longText: string | null,
  shortText: string | null = longText,
): google.maps.places.AddressComponent {
  const fake: FakeComponent = { longText, shortText, types };
  return fake as unknown as google.maps.places.AddressComponent;
}

function asComponents(
  components: google.maps.places.AddressComponent[],
): readonly google.maps.places.AddressComponent[] {
  return components;
}

describe('parseAddressComponents', () => {
  it('parses a typical DE result (street_number + route + locality + postal_code + country)', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['street_number'], '12'),
        component(['route'], 'Musterstraße'),
        component(['locality', 'political'], 'Berlin'),
        component(['postal_code'], '10115'),
        component(['country', 'political'], 'Germany', 'DE'),
      ]),
    );

    expect(result).toEqual({
      line1: 'Musterstraße 12',
      city: 'Berlin',
      post_code: '10115',
      country_code: 'DE',
    });
  });

  it('falls back to postal_town for a GB result missing locality', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['street_number'], '10'),
        component(['route'], 'Downing Street'),
        component(['postal_town'], 'London'),
        component(['postal_code'], 'SW1A 2AA'),
        component(['country', 'political'], 'United Kingdom', 'GB'),
      ]),
    );

    expect(result.city).toBe('London');
    expect(result.country_code).toBe('GB');
  });

  it('falls back to postal_town for an SE result missing locality', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['street_number'], '1'),
        component(['route'], 'Drottninggatan'),
        component(['postal_town'], 'Stockholm'),
        component(['postal_code'], '111 21'),
        component(['country', 'political'], 'Sweden', 'SE'),
      ]),
    );

    expect(result.city).toBe('Stockholm');
    expect(result.country_code).toBe('SE');
  });

  it('falls back to sublocality_level_1 when locality and postal_town are both absent', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['route'], 'Some Lane'),
        component(['sublocality_level_1', 'political'], 'Downtown'),
        component(['postal_code'], '00000'),
        component(['country', 'political'], 'Spain', 'ES'),
      ]),
    );

    expect(result.city).toBe('Downtown');
  });

  it('degrades line1 gracefully when street_number is missing', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['route'], 'Rue de la Paix'),
        component(['locality', 'political'], 'Paris'),
        component(['postal_code'], '75002'),
        component(['country', 'political'], 'France', 'FR'),
      ]),
    );

    expect(result.line1).toBe('Rue de la Paix');
  });

  it('degrades line1 gracefully when route is missing', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['street_number'], '42'),
        component(['locality', 'political'], 'Paris'),
        component(['postal_code'], '75002'),
        component(['country', 'political'], 'France', 'FR'),
      ]),
    );

    expect(result.line1).toBe('42');
  });

  it('degrades line1 gracefully (empty string) when both street_number and route are missing, without throwing', () => {
    expect(() =>
      parseAddressComponents(
        asComponents([
          component(['locality', 'political'], 'Paris'),
          component(['postal_code'], '75002'),
          component(['country', 'political'], 'France', 'FR'),
        ]),
      ),
    ).not.toThrow();

    const result = parseAddressComponents(
      asComponents([
        component(['locality', 'political'], 'Paris'),
        component(['postal_code'], '75002'),
        component(['country', 'political'], 'France', 'FR'),
      ]),
    );
    expect(result.line1).toBe('');
  });

  it('uses the country component shortText (ISO-2), not longText', () => {
    const result = parseAddressComponents(
      asComponents([
        component(['route'], 'Main St'),
        component(['locality', 'political'], 'Dublin'),
        component(['postal_code'], 'D01'),
        component(['country', 'political'], 'Ireland', 'IE'),
      ]),
    );

    expect(result.country_code).toBe('IE');
    expect(result.country_code).not.toBe('Ireland');
  });

  it('returns empty strings for city/post_code/country_code when no matching component exists, without throwing', () => {
    expect(() => parseAddressComponents(asComponents([]))).not.toThrow();
    const result = parseAddressComponents(asComponents([]));
    expect(result).toEqual({ line1: '', city: '', post_code: '', country_code: '' });
  });
});

describe('buildAutocompleteRequest', () => {
  it('sets includedRegionCodes to exactly the one passed country code', () => {
    const sessionToken = {} as google.maps.places.AutocompleteSessionToken;
    const request = buildAutocompleteRequest('Musterstra', sessionToken, 'DE');

    expect(request.includedRegionCodes).toEqual(['DE']);
    expect(request.input).toBe('Musterstra');
    expect(request.sessionToken).toBe(sessionToken);
  });

  it('scopes to a different single country when called again with another code', () => {
    const sessionToken = {} as google.maps.places.AutocompleteSessionToken;
    const request = buildAutocompleteRequest('Downing', sessionToken, 'GB');

    expect(request.includedRegionCodes).toEqual(['GB']);
    expect(request.includedRegionCodes).toHaveLength(1);
  });
});

describe('nextSessionToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a distinct token instance on each call', () => {
    class FakeAutocompleteSessionToken {}
    vi.stubGlobal('google', {
      maps: { places: { AutocompleteSessionToken: FakeAutocompleteSessionToken } },
    });

    const first = nextSessionToken();
    const second = nextSessionToken();

    expect(first).toBeInstanceOf(FakeAutocompleteSessionToken);
    expect(second).toBeInstanceOf(FakeAutocompleteSessionToken);
    expect(first).not.toBe(second);
  });
});
