'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * InPost Geowidget v5 parcel-locker picker. Loads the InPost web component
 * (script + CSS) and surfaces the selected Paczkomat code via `onSelect`.
 * Sandbox vs production assets are chosen by NEXT_PUBLIC_INPOST_GEOWIDGET_ENV.
 *
 * InPost Geowidget v5 event API:
 *   - The `onpoint` attribute on the element specifies the event name InPost
 *     will dispatch on `document` when a locker is selected.
 *   - The event data lives on `event.details` (plural), not `event.detail`.
 *   - Listening on the element itself does NOT work — must use document.
 */

const ENV = process.env.NEXT_PUBLIC_INPOST_GEOWIDGET_ENV ?? 'production';
const TOKEN = process.env.NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN ?? '';
const HOST =
  ENV === 'sandbox'
    ? 'https://sandbox-easy-geowidget-sdk.easypack24.net'
    : 'https://geowidget.inpost.pl';

// Event name InPost will dispatch on document; value of the 'onpoint' attribute.
const POINT_EVENT = 'inpost.point.select';

/** Geowidget supports a limited language set; fall back to Polish. */
function widgetLanguage(locale: string): string {
  return locale === 'en' ? 'en' : 'pl';
}

function ensureAssets() {
  if (typeof document === 'undefined') return;
  if (!document.querySelector('link[data-inpost-geowidget]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${HOST}/inpost-geowidget.css`;
    link.setAttribute('data-inpost-geowidget', '');
    document.head.appendChild(link);
  }
  if (!document.querySelector('script[data-inpost-geowidget]')) {
    const script = document.createElement('script');
    script.src = `${HOST}/inpost-geowidget.js`;
    script.defer = true;
    script.setAttribute('data-inpost-geowidget', '');
    document.head.appendChild(script);
  }
}

export type SelectedPoint = { name: string; address: string };

export function GeowidgetPicker({
  onSelect,
  language = 'pl',
  unavailableLabel,
}: {
  onSelect: (p: SelectedPoint) => void;
  language?: string;
  unavailableLabel?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-mounting the (heavy) widget each render.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!TOKEN) return;
    ensureAssets();
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    // InPost Geowidget v5 dispatches the selection event on `document` using the
    // event name set in the element's `onpoint` attribute. The selected point is
    // in `event.details` (plural) — non-standard but per InPost's v5 API.
    // E2E mocks dispatch `new CustomEvent('onpoint', { detail })` on the element
    // directly; we keep the element listener as a fallback for that path.
    const handlePoint = (e: Event) => {
      const raw = (e as unknown as Record<string, unknown>).details ?? (e as CustomEvent).detail;
      const data = raw as { name?: string; address?: { line1?: string } } | undefined;
      if (data?.name) {
        onSelectRef.current({ name: data.name, address: data.address?.line1 ?? '' });
      }
    };

    // Primary: InPost v5 fires on document with POINT_EVENT as the name.
    document.addEventListener(POINT_EVENT, handlePoint);

    // If the script never loads (blocked/offline), whenDefined never resolves —
    // surface a fallback instead of an indefinitely blank box.
    const timeout = setTimeout(() => {
      if (!cancelled) setFailed(true);
    }, 8000);

    let el: HTMLElement | null = null;
    // The script is injected with `defer`, so the custom element may not be
    // registered yet — wait for it before mounting, otherwise the box is blank.
    customElements.whenDefined('inpost-geowidget').then(() => {
      if (cancelled || !host) return;
      clearTimeout(timeout);
      host.innerHTML = '';
      el = document.createElement('inpost-geowidget');
      el.setAttribute('token', TOKEN);
      el.setAttribute('language', widgetLanguage(language));
      el.setAttribute('config', 'parcelcollect');
      // Tells InPost which event name to dispatch on document upon selection.
      el.setAttribute('onpoint', POINT_EVENT);
      // Fallback: E2E mocks dispatch 'onpoint' directly on this element.
      el.addEventListener('onpoint', handlePoint);
      host.appendChild(el);
      setReady(true);
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      document.removeEventListener(POINT_EVENT, handlePoint);
      if (el) el.removeEventListener('onpoint', handlePoint);
      if (host) host.innerHTML = '';
    };
  }, [language]);

  if (!TOKEN || failed) {
    return <p className="geowidget-msg">{unavailableLabel ?? 'Parcel locker picker unavailable.'}</p>;
  }

  return (
    <div className="geowidget" ref={hostRef} aria-busy={!ready} />
  );
}
