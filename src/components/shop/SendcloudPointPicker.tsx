'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Sendcloud's hosted service point picker (InPost España lockers and Punto Pack
 * points) for the Sendcloud-channel countries. The picker opens as Sendcloud's
 * own overlay — an iframe from embed.sendcloud.sc, allowed in the CSP
 * (src/middleware.ts) — and hands the chosen point back through a callback.
 *
 * The browser's view of the point is only a display hint: checkout sends the
 * point's id and the server re-reads it from Sendcloud
 * (src/server/checkout-service-point.ts) before trusting carrier or country.
 *
 * Authenticates with the integration's PUBLIC key, which Sendcloud designs to
 * be exposed in client code (a build-time NEXT_PUBLIC_ var). Without it, or
 * when the script cannot load, the buyer sees the unavailable message and the
 * pay button stays disabled — never a silent dead button.
 *
 * Docs: https://sendcloud.dev/docs/service-points/integrate-the-hosted-service-point-picker-into-your-checkout
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_SENDCLOUD_PUBLIC_KEY ?? '';
const SCRIPT_SRC = 'https://embed.sendcloud.sc/spp/1.0.0/api.min.js';
const LOAD_TIMEOUT_MS = 8000;

/** The point the picker returned, as the cart shows it. */
export type SendcloudPickedPoint = {
  id: number;
  code: string;
  name: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
};

type PickerServicePoint = {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  street?: unknown;
  house_number?: unknown;
  postal_code?: unknown;
  city?: unknown;
  country?: unknown;
};

type PickerConfig = {
  apiKey: string;
  country: string;
  language: string;
  carriers: string;
};

declare global {
  interface Window {
    sendcloud?: {
      servicePoints?: {
        open(
          config: PickerConfig,
          onSuccess: (point: PickerServicePoint, postNumber: string) => void,
          onFailure: (errors: string[]) => void,
        ): void;
        close(): void;
      };
    };
  }
}

/** The picker has no Polish; Polish visitors get British English. */
export function pickerLanguage(locale: string): string {
  if (locale === 'es') return 'es-es';
  if (locale === 'de') return 'de-de';
  return 'en-gb';
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * The picker's point as the cart keeps it, or null when it is not a usable
 * point in `country` — which also drops an answer from an overlay opened for
 * a country the buyer has since switched away from.
 */
export function toPickedPoint(raw: PickerServicePoint, country: string): SendcloudPickedPoint | null {
  const id = typeof raw.id === 'number' ? raw.id : Number(text(raw.id));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (text(raw.country).toUpperCase() !== country.toUpperCase()) return null;
  return {
    id,
    code: text(raw.code),
    name: text(raw.name) || text(raw.code),
    street: text(raw.street),
    houseNumber: text(raw.house_number),
    postalCode: text(raw.postal_code),
    city: text(raw.city),
    country: country.toUpperCase(),
  };
}

/**
 * Closes the picker overlay without ever throwing. The SDK's close() throws a
 * TypeError when its overlay element is gone (never opened, or already
 * dismissed/answered), and this runs in an effect cleanup: an exception there
 * tears down the whole cart — which is what a delivery-country switch did.
 */
export function closePickerOverlay(api: { close(): void } | undefined): void {
  try {
    api?.close();
  } catch {
    // No overlay to close.
  }
}

function ensureScript() {
  if (typeof document === 'undefined' || document.querySelector('script[data-sendcloud-spp]')) return;
  const script = document.createElement('script');
  script.src = SCRIPT_SRC;
  script.async = true;
  script.setAttribute('data-sendcloud-spp', '');
  document.head.appendChild(script);
}

export function SendcloudPointPicker({
  country,
  carrier,
  language,
  chosen,
  disabled = false,
  onSelect,
  chooseLabel,
  changeLabel,
  unavailableLabel,
  describedBy,
}: {
  country: string;
  carrier: string;
  language: string;
  /** Whether a point is already chosen (switches the button to "change"). */
  chosen: boolean;
  /** Locks the picker (a checkout request is in flight). */
  disabled?: boolean;
  onSelect: (point: SendcloudPickedPoint) => void;
  chooseLabel: string;
  changeLabel: string;
  unavailableLabel: string;
  /** Id of the cart's inline error for the point, when one is shown. */
  describedBy?: string;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(PUBLIC_KEY ? 'loading' : 'failed');
  // Latest props for the overlay's callbacks, without re-opening it.
  const latest = useRef({ country, onSelect });
  useEffect(() => {
    latest.current = { country, onSelect };
  });
  // Whether this mount's overlay is open — only then is there anything to close.
  const overlayOpen = useRef(false);

  useEffect(() => {
    if (!PUBLIC_KEY) return;
    ensureScript();
    const started = Date.now();
    // Poll rather than rely on onload: the script may already be cached in the
    // page from an earlier mount, and the E2E seam pre-defines the API.
    const timer = setInterval(() => {
      if (window.sendcloud?.servicePoints) {
        clearInterval(timer);
        setState('ready');
      } else if (Date.now() - started > LOAD_TIMEOUT_MS) {
        clearInterval(timer);
        setState('failed');
      }
    }, 100);
    return () => {
      clearInterval(timer);
      // Unmounting (country switch, method switch, payment step) with the
      // overlay still up must take it down; with no overlay, close() throws.
      if (overlayOpen.current) closePickerOverlay(window.sendcloud?.servicePoints);
      overlayOpen.current = false;
    };
  }, []);

  if (state === 'failed') {
    return (
      <p className="geowidget-msg" data-testid="point-picker-unavailable">
        {unavailableLabel}
      </p>
    );
  }

  function open() {
    const api = window.sendcloud?.servicePoints;
    if (!api) return;
    overlayOpen.current = true;
    api.open(
      { apiKey: PUBLIC_KEY, country, language: pickerLanguage(language), carriers: carrier },
      (raw) => {
        // The SDK removes its overlay itself once it answers.
        overlayOpen.current = false;
        const point = toPickedPoint(raw, latest.current.country);
        if (point) latest.current.onSelect(point);
      },
      (errors) => {
        // 'Closed' is the buyer dismissing the overlay — not an error — and
        // the only failure after which the SDK removes it. 'Invalid event
        // type' leaves the overlay up, so cleanup must still close it; a
        // config failure never mounted one, and closePickerOverlay absorbs
        // that close() throwing.
        if (errors.includes('Closed')) {
          overlayOpen.current = false;
          return;
        }
        console.warn('[sendcloud-picker]', errors.join(', '));
      },
    );
  }

  return (
    <button
      type="button"
      className="btn btn-ghost locker-toggle"
      data-testid={chosen ? 'change-locker' : 'choose-locker'}
      disabled={disabled || state !== 'ready'}
      aria-busy={state !== 'ready'}
      aria-describedby={describedBy}
      onClick={open}
    >
      {chosen ? changeLabel : chooseLabel}
    </button>
  );
}
