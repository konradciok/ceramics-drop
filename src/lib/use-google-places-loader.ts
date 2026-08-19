'use client';

import { useEffect, useState } from 'react';
import { readConsent } from '@/components/consent/consent-mode';

/**
 * Consent-gated loader for the Google Maps JavaScript API's dynamic library
 * import bootstrap loader, used to pull in the `places` library for address
 * autocomplete on the print checkout delivery form.
 *
 * Google Places is a third-party ad-tech-adjacent script (Google), so — like
 * GTM/GA4/Meta Pixel — it must never load before the visitor has granted
 * consent (Consent Mode v2 default-deny). Unlike the analytics scripts,
 * there's no server-side fallback here: if consent is denied or the API key
 * is unset, autocomplete simply never loads and the plain text address
 * fields remain the only way to fill delivery details.
 */

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;

/**
 * Pure gating decision: load only when the visitor has explicitly granted
 * consent (not denied, not undecided) AND an API key is configured. Exported
 * separately from the DOM effect so it can be unit-tested without a browser
 * environment.
 */
export function shouldLoadGooglePlaces(
  consentCookie: string,
  apiKey: string | undefined,
): boolean {
  return readConsent(consentCookie) === 'granted' && Boolean(apiKey);
}

/**
 * Idempotently append Google's small inline "dynamic library import"
 * bootstrap loader (the snippet Google's own docs publish for copy-paste —
 * https://developers.google.com/maps/documentation/javascript/load-maps-js-api).
 * It defines `google.maps.importLibrary` itself; the actual Maps JS API
 * script is only fetched lazily, the first time a library is imported.
 * Guarded by a `data-google-places` marker so it only runs once per page,
 * mirroring GeowidgetPicker.tsx's `ensureAssets()` pattern.
 */
function ensureBootstrapLoader(documentRef: Document, apiKey: string): void {
  if (documentRef.querySelector('script[data-google-places]')) return;
  const script = documentRef.createElement('script');
  script.setAttribute('data-google-places', '');
  script.textContent = `(g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=\`https://maps.\${c}apis.com/maps/api/js?\`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({key:${JSON.stringify(apiKey)},v:"weekly"});`;
  documentRef.head.appendChild(script);
}

/**
 * Gate + DOM-injection logic extracted from the hook's effect so it can be
 * unit-tested directly (this repo's vitest runs `environment: 'node'` — no
 * jsdom, no React Testing Library). When the gate fails, this is a no-op:
 * no script is appended and `google.maps.importLibrary` is never called.
 * When the gate passes, it appends the bootstrap loader (once) and awaits
 * `google.maps.importLibrary('places')`.
 */
export async function runGooglePlacesLoader(
  consentCookie: string,
  apiKey: string | undefined,
  documentRef: Document,
): Promise<void> {
  if (!shouldLoadGooglePlaces(consentCookie, apiKey)) return;
  ensureBootstrapLoader(documentRef, apiKey as string);
  await google.maps.importLibrary('places');
}

const LOAD_TIMEOUT_MS = 8000;

/**
 * Client hook: loads the Google Places library (consent + API-key gated)
 * and resolves once `importLibrary('places')` is ready. Mirrors
 * GeowidgetPicker.tsx's timeout-fallback shape: if loading never resolves
 * (blocked, offline, misconfigured), `failed` flips to true after 8s so
 * callers can fall back to plain text address fields.
 */
export function useGooglePlacesLoader(): { ready: boolean; failed: boolean } {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const consentCookie = document.cookie;
    if (!shouldLoadGooglePlaces(consentCookie, API_KEY)) return;

    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) setFailed(true);
    }, LOAD_TIMEOUT_MS);

    runGooglePlacesLoader(consentCookie, API_KEY, document)
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
     
  }, []);

  return { ready, failed };
}
