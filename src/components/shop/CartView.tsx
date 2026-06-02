'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { useCart } from '@/store/cart';
import { resolveCartProducts, CATEGORIES } from '@/lib/products';
import { pln } from '@/lib/format';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { Link } from '@/i18n/navigation';
import {
  buildBeginCheckoutEvent,
  buildRemoveFromCartEvent,
  buildViewCartEvent,
  pushDataLayer,
} from '@/lib/analytics';
import { SHIPPING_PLN } from '@/lib/pricing';
import { CheckoutForm } from './CheckoutForm';

/**
 * Cart / checkout screen.
 * Reference: design/assets/shop.js renderCart (714–788), shipOpt (783–788),
 * checkout (790–811).
 */

type ShipId = 'kurier' | 'odbior';

interface ShipOptionProps {
  id: ShipId;
  active: boolean;
  onPick: (id: ShipId) => void;
  title: string;
  desc: string;
  price: string;
}

function ShipOption({ id, active, onPick, title, desc, price }: ShipOptionProps) {
  return (
    <div
      className={`ship-opt${active ? ' sel' : ''}`}
      onClick={() => onPick(id)}
      role="radio"
      aria-checked={active}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPick(id); }}
    >
      <span className="ship-radio" />
      <div style={{ flex: 1 }}>
        <div className="so-t">
          <span>{title}</span>
          <span>{price}</span>
        </div>
        <div className="so-d">{desc}</div>
      </div>
    </div>
  );
}

/** Empty-state see-* buttons: maps CATEGORY_ORDER slugs to i18n keys. */
const SEE_KEYS: { key: string; href: string; primary?: boolean }[] = [
  { key: 'seeMugs',       href: '/kubki',          primary: true },
  { key: 'seeVases',      href: '/wazony' },
  { key: 'seeBigvases',   href: '/wazony-duze' },
  { key: 'seeDishes',     href: '/talerzyki' },
  { key: 'seePlates',     href: '/talerze-duze' },
  { key: 'seeLargebowls', href: '/duze-michy' },
  { key: 'seeWavybowls',  href: '/miski-falowane' },
];

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export function CartView() {
  const t = useTranslations();
  const ids = useCart((s) => s.ids);
  const remove = useCart((s) => s.remove);

  // Shipping choice — lazy-init from sessionStorage (SSR-safe via typeof window guard)
  const [ship, setShip] = useState<ShipId>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('acc_ship');
      if (saved === 'kurier' || saved === 'odbior') return saved;
    }
    return 'kurier';
  });

  const viewedCartKeys = useRef(new Set<string>());
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Persist ship choice to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('acc_ship', ship);
  }, [ship]);

  // Prune already-sold items from the cart on mount
  useEffect(() => {
    fetch('/api/inventory')
      .then((r) => r.json())
      .then(({ sold }: { sold: string[] }) => sold.forEach((id) => { if (ids.includes(id)) remove(id); }))
      .catch(() => {});
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const products = resolveCartProducts(ids);
  const n = products.length;
  const subtotal = products.reduce((s, p) => s + p.price, 0);
  const shipCost = ship === 'odbior' ? 0 : SHIPPING_PLN;
  const total = subtotal + shipCost;
  const productKey = products.map((p) => p.id).join('|');

  useEffect(() => {
    if (products.length === 0 || viewedCartKeys.current.has(productKey)) return;
    viewedCartKeys.current.add(productKey);
    pushDataLayer(buildViewCartEvent(products));
  }, [productKey, products]);

  function handlePickShip(id: ShipId) {
    setShip(id);
  }

  async function handleCheckout() {
    if (products.length === 0) return;
    setCheckoutError(null);
    pushDataLayer(
      buildBeginCheckoutEvent(products, { shippingCost: shipCost, shippingMethod: ship }),
    );
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: products.map((p) => p.id), shipping_method: ship }),
    });
    if (res.status === 409) {
      const { sold } = (await res.json()) as { sold: string[] };
      sold.forEach((id) => remove(id));
      setCheckoutError(t('cart.soldOut'));
      return;
    }
    if (!res.ok) {
      setCheckoutError(t('cart.payError'));
      return;
    }
    const { client_secret } = (await res.json()) as { client_secret: string };
    setClientSecret(client_secret);
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (n === 0) {
    return (
      <div className="cart-empty">
        <h2>{t.rich('cart.emptyH', richTags)}</h2>
        <p>{t('cart.emptyP')}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {SEE_KEYS.map(({ key, href, primary }) => (
            <Link
              key={key}
              href={href}
              className={primary ? 'btn btn-primary' : 'btn btn-ghost'}
            >
              {t(`cart.${key}` as Parameters<typeof t>[0])}
              {primary && <> <Icon name="arrow" /></>}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // ── Filled cart ──────────────────────────────────────────────────────────
  return (
    <div className="cart-wrap">
      <div>
        <div className="cart-head">
          <div className="eyebrow">{t('cart.eyebrow')}</div>
          <h1>
            {t('cart.label')} <em>—</em> {n} {t('cart.word', { count: n })}
          </h1>
        </div>
        <div className="cart-list">
          {products.map((p) => {
            const cat = CATEGORIES[p.category];
            const name = t(`product.${cat.singularKey}` as Parameters<typeof t>[0]);
            return (
              <div key={p.id} className="cart-row">
                <Link href={`/${p.category}`} className="thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} alt="" />
                </Link>
                <div>
                  <h4>{name} Nº {p.num}</h4>
                  <div className="meta">{name} {t('cart.oneoff')}</div>
                </div>
                <div className="right">
                  <span className="price">{pln(p.price)}</span>
                  <button
                    className="rm"
                    onClick={() => {
                      remove(p.id);
                      pushDataLayer(buildRemoveFromCartEvent(p));
                    }}
                  >
                    <Icon name="trash" /> {t('cart.remove')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="summary">
        <h3>{t('cart.summary')}</h3>
        <div className="sum-row">
          <span className="k">{t('cart.pieces')} ({n})</span>
          <span className="v">{pln(subtotal)}</span>
        </div>
        <div className="ship-opts" role="radiogroup" aria-label={t('cart.summary')}>
          <ShipOption
            id="kurier"
            active={ship === 'kurier'}
            onPick={handlePickShip}
            title={t('ship.courierT')}
            desc={t('ship.courierD')}
            price={t('ship.courierPrice')}
          />
          <ShipOption
            id="odbior"
            active={ship === 'odbior'}
            onPick={handlePickShip}
            title={t('ship.pickupT')}
            desc={t('ship.pickupD')}
            price={t('ship.pickupPrice')}
          />
        </div>
        <div className="sum-row">
          <span className="k">{t('cart.delivery')}</span>
          <span className="v">{shipCost > 0 ? pln(shipCost) : t('cart.free')}</span>
        </div>
        <div className="sum-total">
          <span className="k">{t('cart.total')}</span>
          <span className="v">{pln(total)}</span>
        </div>
        {clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret, locale: 'pl' }}>
            <CheckoutForm returnUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/koszyk/return`} />
          </Elements>
        ) : (
          <button className="btn btn-primary" id="checkout" onClick={handleCheckout}>
            {t('cart.checkout')} <Icon name="arrow" />
          </button>
        )}
        {checkoutError && <p className="pay-error">{checkoutError}</p>}
        <p className="fineprint">
          {t.rich('cart.fineprint', richTags)}
        </p>
      </aside>
    </div>
  );
}
