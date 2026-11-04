'use client';

import { useSyncExternalStore } from 'react';
import { Link } from '@/i18n/navigation';

/** Promo copy shows until this instant (1 Dec 2026 00:00 Europe/Warsaw = 30 Nov 23:00 UTC). */
export const ANNOUNCE_PROMO_UNTIL = Date.parse('2026-11-30T23:00:00Z');

// Never-changing store: the bar only needs the clock once, after hydration.
const subscribe = () => () => {};
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
