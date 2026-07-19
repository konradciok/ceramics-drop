'use client';

import { useState } from 'react';
import { srcSet } from '@/lib/images';
import { useTranslations } from 'next-intl';

type Props = {
  images: string[];
  alt: string;
  /** When this changes, the gallery snaps back to slide 0 (the configurator
      hero) so a variant change is visible from any slide. */
  syncKey?: string;
};

/** Image gallery for the product detail page with dot navigation. */
export function ProductPageGallery({ images, alt, syncKey }: Props) {
  const t = useTranslations();
  const [index, setIndex] = useState(0);
  // Reset to slide 0 when syncKey changes, adjusting state during render
  // (React's prescribed pattern) instead of useEffect — avoids the extra
  // commit an effect-based reset would cost and satisfies
  // react-hooks/set-state-in-effect.
  const [prevSyncKey, setPrevSyncKey] = useState(syncKey);
  if (syncKey !== prevSyncKey) {
    setPrevSyncKey(syncKey);
    setIndex(0);
  }
  const current = images[index] ?? images[0];

  return (
    <div className="pdp-images">
      <div className="pdp-img-main">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current}
          src={current}
          srcSet={srcSet(current)}
          sizes="(min-width:861px) min(55vw, 720px), 100vw"
          alt={index === 0 ? alt : ''}
          aria-hidden={index !== 0}
        />
      </div>
      {images.length > 1 && (
        <div className="pdp-img-dots" role="group" aria-label={t('aria.photo')}>
          {images.map((img, i) => (
            <button
              key={img}
              className={`pdp-img-dot${i === index ? ' active' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`${t('aria.photo')} ${i + 1}`}
              aria-current={i === index}
            />
          ))}
        </div>
      )}
    </div>
  );
}
