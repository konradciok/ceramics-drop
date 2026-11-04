'use client';

import { useSyncExternalStore } from 'react';
import { Link } from '@/i18n/navigation';

/** Promo copy shows until this instant (1 Dec 2026 00:00 Europe/Warsaw = 30 Nov 23:00 UTC). */
export const ANNOUNCE_PROMO_UNTIL = Date.parse('2026-11-30T23:00:00Z');

// setTimeout stores its delay as a signed 32-bit int (~24.8 days); a longer
// delay fires immediately, so wait in chunks until the cutoff is reached.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Notify React when the cutoff passes (open tab) or the tab wakes up (a
// suspended/sleeping tab's timer may be late), so the bar swaps without a reload.
function subscribe(onChange: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = ANNOUNCE_PROMO_UNTIL - Date.now();
    if (remaining <= 0) return;
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, Math.min(remaining, MAX_TIMEOUT_MS));
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') onChange();
  };
  schedule();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
const getPromoOver = () => Date.now() >= ANNOUNCE_PROMO_UNTIL;
// Server HTML always carries the promo copy (the page may be prerendered, so a
// render-time Date.now() would freeze at build time).
const getServerPromoOver = () => false;

type Props = { promo: string; regular: string };

/**
 * Announcement bar. After hydration it falls back to the regular line once the
 * promo has ended — no redeploy needed.
 */
export function AnnounceBar({ promo, regular }: Props) {
  const promoOver = useSyncExternalStore(subscribe, getPromoOver, getServerPromoOver);

  return (
    <div className="announce">
      <span className="dot" />
      {promoOver ? (
        regular
      ) : (
        <Link href="/sklep" className="announce-link">
          {promo}
        </Link>
      )}
      <span className="dot" />
    </div>
  );
}
