'use client';

/* ============================================================
   PrintPdpPurchase — client shell that makes the PDP hero follow the
   configurator (TPC-style live mockup). Owns the variant selection and
   renders the gallery + configurator; the server-rendered heading and spec
   blocks flow through as ReactNode slots. For designs without the
   `mockups` flag the hero src never changes — byte-identical to the old
   sibling-islands layout.
   ============================================================ */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { ProductPageGallery } from './ProductPageGallery';
import { PrintConfigurator } from './PrintConfigurator';
import { designMockupStates, mockupHeroSrc, mockupSrc } from '@/lib/print-mockups';
import { srcSet } from '@/lib/images';
import { variantLabel } from '@/lib/print-cart';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import type { PrintDesign, PrintVariantSelection } from '@/lib/types';

export function PrintPdpPurchase({
  design,
  images,
  alt,
  usableVariantKeys,
  pricing,
  header,
  footer,
}: {
  design: PrintDesign;
  images: string[];
  alt: string;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  header: ReactNode;
  footer: ReactNode;
}) {
  const locale = useLocale();
  const [sel, setSel] = useState<PrintVariantSelection>({
    size: design.sizes[0],
    framed: false,
    mount: false,
    frameColour: 'none',
  });

  const heroSrc = mockupHeroSrc(design, sel);
  const heroImages = [heroSrc, ...images.slice(1)];

  // Warm the (≤6) mockup variants once so swaps render without flicker.
  // srcset/sizes mirror ProductPageGallery's hero <img> so the browser warms
  // the SAME responsive candidate it will render, not the full-size WebP.
  useEffect(() => {
    if (!design.mockups) return;
    for (const state of designMockupStates(design)) {
      const src = mockupSrc(design, state);
      if (src) {
        const image = new Image();
        image.srcset = srcSet(src);
        image.sizes = '(min-width:861px) min(55vw, 720px), 100vw';
        image.src = src;
      }
    }
  }, [design]);

  return (
    <>
      <ProductPageGallery
        images={heroImages}
        // Only describe the selected variant when the hero actually follows it;
        // a static hero (no mockups flag) always shows the plain artwork.
        alt={design.mockups ? `${alt} — ${variantLabel(sel, locale)}` : alt}
        syncKey={heroSrc}
      />
      <div className="pdp-body">
        {header}
        <PrintConfigurator
          design={design}
          usableVariantKeys={usableVariantKeys}
          pricing={pricing}
          sel={sel}
          onSelChange={setSel}
        />
        {footer}
      </div>
    </>
  );
}
