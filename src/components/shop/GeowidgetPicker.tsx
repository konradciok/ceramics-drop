'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * InPost Geowidget v5 parcel-locker picker. Loads the InPost web component
 * (script + CSS) and surfaces the selected Paczkomat code via `onSelect`.
 * Sandbox vs production assets are chosen by NEXT_PUBLIC_INPOST_GEOWIDGET_ENV.
 */

const ENV = process.env.NEXT_PUBLIC_INPOST_GEOWIDGET_ENV ?? 'production';
const TOKEN = process.env.NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN ?? '';
const HOST =
  ENV === 'sandbox'
    ? 'https://sandbox-easy-geowidget-sdk.easypack24.net'
    : 'https://geowidget.inpost.pl';

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

  useEffect(() => {
    if (!TOKEN) return;
    ensureAssets();
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { name?: string; address?: { line1?: string } }
        | undefined;
      if (detail?.name) {
        onSelectRef.current({ name: detail.name, address: detail.address?.line1 ?? '' });
      }
    };

    let el: HTMLElement | null = null;
    // The script is injected with `defer`, so the custom element may not be
    // registered yet — wait for it before mounting, otherwise the box is blank.
    customElements.whenDefined('inpost-geowidget').then(() => {
      if (cancelled || !host) return;
      host.innerHTML = '';
      el = document.createElement('inpost-geowidget');
      el.setAttribute('token', TOKEN);
      el.setAttribute('language', widgetLanguage(language));
      el.setAttribute('config', 'parcelcollect');
      el.addEventListener('onpoint', handler as EventListener);
      host.appendChild(el);
      setReady(true);
    });

    return () => {
      cancelled = true;
      if (el) el.removeEventListener('onpoint', handler as EventListener);
      if (host) host.innerHTML = '';
    };
  }, [language]);

  if (!TOKEN) {
    return <p className="geowidget-msg">{unavailableLabel ?? 'Parcel locker picker unavailable.'}</p>;
  }

  return (
    <div className="geowidget" ref={hostRef} aria-busy={!ready} />
  );
}
