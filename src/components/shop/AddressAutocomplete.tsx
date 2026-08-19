'use client';

/// <reference types="google.maps" />

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useGooglePlacesLoader } from '@/lib/use-google-places-loader';
import {
  buildAutocompleteRequest,
  nextSessionToken,
  parseAddressComponents,
  type ParsedPlaceAddress,
} from '@/lib/google-places';
import type { PrintCountry } from '@/lib/print-shipping';

/**
 * ARIA-combobox address autocomplete for the print checkout's `line1` field.
 * Controlled component (KTD): receives `value`/`onChange` for the plain text
 * input plus an `onSelectPlace(parsed)` callback for a chosen suggestion —
 * it never reads or writes `PrintDeliveryForm`'s `Draft` state directly,
 * mirroring `GeowidgetPicker`'s `onSelect` shape.
 *
 * Fail-open (R4/R5): when the Google Places loader isn't ready or has
 * failed, this renders the exact same plain `<input>` `PrintDeliveryForm`
 * had before this feature existed — no dropdown, no attribution, no
 * network request. `line1` has no equivalent "unavailable" escape hatch
 * (unlike `GeowidgetPicker`'s locker picker), so autocomplete must never
 * become a checkout blocker.
 */

const DEBOUNCE_MS = 200;

export function AddressAutocomplete({
  value,
  onChange,
  onSelectPlace,
  onBlur,
  countryCode,
  name,
  required,
  autoComplete,
  suggestionsLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSelectPlace: (parsed: ParsedPlaceAddress) => void;
  onBlur: () => void;
  countryCode: PrintCountry;
  name: string;
  required?: boolean;
  autoComplete?: string;
  suggestionsLabel: string;
  'aria-invalid'?: true | undefined;
  'aria-describedby'?: string | undefined;
}) {
  const { ready, failed } = useGooglePlacesLoader();

  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Session tokens are Google's billing-grouping mechanism (KTD): one per
  // typing session, minted lazily on first fetch and refreshed after a
  // place is selected.
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id — discards any response that isn't the latest,
  // since two in-flight requests can resolve out of order on a real
  // network (stale-response guard from code review).
  const requestIdRef = useRef(0);
  const skipNextCountryRefetchRef = useRef(true);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  function ensureSessionToken(): google.maps.places.AutocompleteSessionToken {
    if (!sessionTokenRef.current) sessionTokenRef.current = nextSessionToken();
    return sessionTokenRef.current;
  }

  function closeList() {
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(null);
  }

  function fetchSuggestions(query: string, country: PrintCountry) {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (!query.trim()) {
      closeList();
      return;
    }
    const request = buildAutocompleteRequest(query, ensureSessionToken(), country);
    google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
      .then((response) => {
        if (requestId !== requestIdRef.current) return; // stale response — discard
        // A valid in-country query with zero predictions collapses the
        // listbox, same as the R10 country-mismatch case (post-fetch, not
        // pre-fetch, trigger).
        const next = response.suggestions ?? [];
        setSuggestions(next);
        setOpen(next.length > 0);
        setActiveIndex(null);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        closeList();
      });
  }

  function scheduleFetch(query: string, country: PrintCountry) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(query, country), DEBOUNCE_MS);
  }

  // Rescope in-flight/soon-to-be suggestions to the newly-selected country.
  // Typing after a country change already picks up the new country (the
  // debounced fetch always reads the current `countryCode` prop) — this
  // effect additionally invalidates a currently-open, now-mis-scoped list
  // as soon as the country changes, without waiting for the next keystroke.
  useEffect(() => {
    if (skipNextCountryRefetchRef.current) {
      skipNextCountryRefetchRef.current = false;
      return;
    }
    if (!ready || !open) return;
    scheduleFetch(value, countryCode);
    // Only re-run on country change — `value`/`open`/`ready` are read fresh
    // at call time via the closure above, not tracked as effect deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode]);

  async function selectSuggestion(suggestion: google.maps.places.AutocompleteSuggestion) {
    const placePrediction = suggestion.placePrediction;
    if (!placePrediction) return;
    closeList();
    try {
      const place = placePrediction.toPlace();
      const { place: fetchedPlace } = await place.fetchFields({ fields: ['addressComponents'] });
      const parsedAddress = parseAddressComponents(fetchedPlace.addressComponents ?? []);
      onSelectPlace(parsedAddress);
    } finally {
      // A new session begins after a place is selected (KTD) — reusing the
      // spent token would bill every keystroke of the next address as a
      // separate request.
      sessionTokenRef.current = nextSessionToken();
    }
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    onChange(next);
    if (!ready) return;
    scheduleFetch(next, countryCode);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!ready || !open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current === null ? 0 : Math.min(current + 1, suggestions.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current === null ? suggestions.length - 1 : Math.max(current - 1, 0)));
    } else if (event.key === 'Enter') {
      if (activeIndex !== null) {
        event.preventDefault();
        void selectSuggestion(suggestions[activeIndex]);
      }
      // No highlighted option — let Enter fall through to the form's
      // existing submit behavior.
    } else if (event.key === 'Tab') {
      if (activeIndex !== null) {
        // Select but don't preventDefault — Tab should still move focus.
        void selectSuggestion(suggestions[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      // Close without altering typed text.
      closeList();
    }
  }

  const listboxId = `${name}-listbox`;
  const optionId = (index: number) => `${name}-option-${index}`;

  if (!ready || failed) {
    return (
      <input
        name={name}
        required={required}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
      />
    );
  }

  return (
    <div className="addr-autocomplete">
      <input
        name={name}
        required={required}
        autoComplete={autoComplete}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          closeList();
          onBlur();
        }}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex !== null ? optionId(activeIndex) : undefined}
      />
      {open && suggestions.length > 0 && (
        <div className="addr-suggestions-panel">
          <ul className="addr-suggestions" role="listbox" id={listboxId} aria-label={suggestionsLabel}>
            {suggestions.map((suggestion, index) => {
              const placePrediction = suggestion.placePrediction;
              if (!placePrediction) return null;
              return (
                <li
                  key={placePrediction.placeId}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? 'addr-suggestion is-active' : 'addr-suggestion'}
                  onMouseDown={(e) => {
                    // Prevent the input from blurring before the click is
                    // processed, so `onBlur` doesn't close the list first.
                    e.preventDefault();
                    void selectSuggestion(suggestion);
                  }}
                >
                  {placePrediction.text.text}
                </li>
              );
            })}
          </ul>
          {/* Required attribution (R9) — shown exactly when suggestions are visible. */}
          <p className="addr-attribution">Powered by Google</p>
        </div>
      )}
    </div>
  );
}
