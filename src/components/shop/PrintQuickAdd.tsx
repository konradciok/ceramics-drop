'use client';

/* ============================================================
   PrintQuickAdd — modal size/frame picker opened from a /sklep card.
   Wraps the PDP's own PrintConfigurator (variant axes, live price, asset
   gating, mixed-cart block, add/remove analytics) in a native <dialog>, so
   there is exactly one add-to-cart implementation for prints. Loaded lazily
   by PrintShopCard on first open.
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import type { PrintCollectionDefinition } from '@/lib/print-curation';
import type { PrintDesign, PrintVariantSelection } from '@/lib/types';
import { PrintConfigurator } from './PrintConfigurator';

export default function PrintQuickAdd({
  design,
  name,
  image,
  usableVariantKeys,
  pricing,
  definitions,
  onClose,
}: {
  design: PrintDesign;
  name: string;
  image: string;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  definitions: PrintCollectionDefinition[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const ref = useRef<HTMLDialogElement>(null);
  // Same entry variant the tile's "from" price and analytics use: first size, unframed.
  const [sel, setSel] = useState<PrintVariantSelection>({
    size: design.sizes[0],
    framed: false,
    mount: false,
    frameColour: 'none',
  });

  useEffect(() => {
    const dialog = ref.current;
    // No cleanup close: React StrictMode re-runs effects in dev, and a close()
    // here would fire `close` → onClose → unmount the dialog straight away.
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="shop-quick"
      aria-label={name}
      data-testid="print-quick-add"
      onClose={onClose}
      onClick={(e) => {
        // A click on the ::backdrop targets the <dialog> itself.
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="shop-quick-inner">
        <button type="button" className="shop-quick-close" aria-label={t('shop.close')} onClick={() => ref.current?.close()}>
          <span aria-hidden="true">×</span>
        </button>
        <div className="shop-quick-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} srcSet={srcSet(image)} sizes="96px" alt="" width={96} height={137} />
          <div>
            <h2>{name}</h2>
            <Link href={`/fine-art-prints/${design.id}`} className="shop-quick-details">
              {t('shop.quickDetails')}
            </Link>
          </div>
        </div>
        <PrintConfigurator
          design={design}
          usableVariantKeys={usableVariantKeys}
          pricing={pricing}
          sel={sel}
          onSelChange={setSel}
          definitions={definitions}
        />
      </div>
    </dialog>
  );
}
