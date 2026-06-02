'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { euro } from '@/lib/format';
import { CATEGORIES } from '@/lib/products';
import type { Product } from '@/lib/types';

type Props = {
  /** Available (unsold) pieces the lightbox can page through. */
  products: Product[];
  /** Index into `products`, or null when closed. */
  index: number | null;
  onClose: () => void;
  onStep: (delta: number) => void;
};

/** Product detail popup. */
export function Lightbox({ products, index, onClose, onStep }: Props) {
  const t = useTranslations();
  const ids = useCart((s) => s.ids);
  const toggle = useCart((s) => s.toggle);

  const open = index !== null;
  const product = open ? products[index] : undefined;
  const inCart = product ? ids.includes(product.id) : false;

  const cat = product ? CATEGORIES[product.category] : undefined;
  const name = cat ? t(`product.${cat.singularKey}`) : '';
  const rawNotes = product ? (t.raw(`notes.${product.category}`) as unknown) : undefined;
  const note = product && Array.isArray(rawNotes) ? (rawNotes[product.noteIndex] as string) ?? '' : '';

  return (
    <>
      <div className={`lb-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <div
        className={`lb${open ? ' open' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {product && (
          <div className="lb-card">
            <div className="lb-img">
              <button className="lb-close" onClick={onClose} aria-label={t('aria.close')}>
                <Icon name="close" />
              </button>
              <button className="lb-nav lb-prev" onClick={() => onStep(-1)} aria-label={t('aria.prev')}>
                <Icon name="chevron-left" />
              </button>
              <button className="lb-nav lb-next" onClick={() => onStep(1)} aria-label={t('aria.next')}>
                <Icon name="chevron-right" />
              </button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.image} alt={`${name} Nº ${product.num}`} />
            </div>
            <div className="lb-body">
              <div className="eyebrow lb-eyebrow">
                {cat ? `${t(cat.nameKey)} — ${t('lightbox.drop')}` : ''}
              </div>
              <h3>{name} <em>Nº {product.num}</em></h3>
              <div className="lb-price">{euro(product.price)}</div>
              <p className="lb-note">{note}</p>
              <div className="lb-specs">
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specDims')}</span>
                  <span className="v">{`${t('lightbox.approx')} ${product.measure}`}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specTech')}</span>
                  <span className="v">{t('lightbox.specTechVal')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specCopy')}</span>
                  <span className="v">{t('lightbox.specCopyVal')}</span>
                </div>
              </div>
              <button
                className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
                onClick={() => toggle(product.id)}
              >
                {inCart ? t('lightbox.in') : t('lightbox.add')}
                <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
