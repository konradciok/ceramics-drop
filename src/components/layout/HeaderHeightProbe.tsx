'use client';
import { useEffect } from 'react';

/**
 * Measures the sticky `.header` and publishes its real height to the
 * `--header-h` custom property. Sticky offsets (`.summary`, `.prose-toc`) and
 * anchor `scroll-margin`/`scroll-padding-top` all read that token, so this keeps
 * them aligned to the actual header instead of the static fallback in tokens.css.
 *
 * Only the sticky `.header` is measured — the `.announce` bar scrolls away and
 * must NOT be included in the offset. SSR keeps the static token until hydration;
 * since the token only affects scroll-time positioning, there is no visible jump.
 */
export function HeaderHeightProbe() {
  useEffect(() => {
    const header = document.querySelector('.header');
    if (!header) return;
    const root = document.documentElement;
    const apply = () => {
      const h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) root.style.setProperty('--header-h', `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  return null;
}
