/// <reference types="google.maps" />
import type { PrintCountry } from './print-shipping';

/** The subset of a selected Google Place's address we care about for print checkout. */
export type ParsedPlaceAddress = {
  line1: string;
  city: string;
  post_code: string;
  country_code: string;
};

/**
 * Find the first address component whose `types` includes the given Google
 * place-type string. Never accesses `components` by array position — Google
 * does not guarantee component ordering, and GB/SE results in particular
 * return `postal_town` in place of `locality`.
 */
function findComponent(
  components: readonly google.maps.places.AddressComponent[],
  type: string,
): google.maps.places.AddressComponent | undefined {
  return components.find((component) => component.types.includes(type));
}

/**
 * Parse a selected place's address components into the shape
 * `PrintDeliveryForm` autofills: `{ line1, city, post_code, country_code }`.
 *
 * - `line1` composes as `${route} ${street_number}`.trim() (the store's
 *   existing single-line convention), degrading gracefully when either part
 *   is missing rather than throwing.
 * - `city` resolves `locality → postal_town → sublocality_level_1` — GB and
 *   SE (both in `PRINT_COUNTRIES`) return `postal_town` instead of `locality`.
 * - `country_code` uses the `country` component's ISO-2 `shortText`, not the
 *   full `longText` name.
 */
export function parseAddressComponents(
  components: readonly google.maps.places.AddressComponent[],
): ParsedPlaceAddress {
  const route = findComponent(components, 'route');
  const streetNumber = findComponent(components, 'street_number');
  const locality = findComponent(components, 'locality');
  const postalTown = findComponent(components, 'postal_town');
  const sublocality = findComponent(components, 'sublocality_level_1');
  const postalCode = findComponent(components, 'postal_code');
  const country = findComponent(components, 'country');

  const line1 = [route?.longText, streetNumber?.longText]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(' ')
    .trim();

  const city = locality?.longText ?? postalTown?.longText ?? sublocality?.longText ?? '';

  return {
    line1,
    city,
    post_code: postalCode?.longText ?? '',
    country_code: country?.shortText ?? '',
  };
}

/**
 * Build a country-scoped `AutocompleteRequest` for
 * `google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions`.
 * `includedRegionCodes` is a hard restriction to the single currently-selected
 * print-delivery country, not a bias — see R10/AE5 in the plan.
 */
export function buildAutocompleteRequest(
  query: string,
  sessionToken: google.maps.places.AutocompleteSessionToken,
  countryCode: PrintCountry,
): google.maps.places.AutocompleteRequest {
  return {
    input: query,
    includedRegionCodes: [countryCode],
    sessionToken,
  };
}

/**
 * Mint a fresh `AutocompleteSessionToken`. Callers never construct one
 * directly — session tokens are Google's billing-grouping mechanism, and a
 * new one is required per typing session (after a place is selected or the
 * field resets) to avoid billing every keystroke as a separate request.
 */
export function nextSessionToken(): google.maps.places.AutocompleteSessionToken {
  return new google.maps.places.AutocompleteSessionToken();
}
