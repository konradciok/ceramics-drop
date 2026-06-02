'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { resolveCartProducts, CATEGORIES } from '@/lib/products';
import { euro } from '@/lib/format';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { Link } from '@/i18n/navigation';

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

interface ConfirmState {
  n: number;
  total: number;
  orderNo: string;
}

export function CartView() {
  const t = useTranslations();
  const ids = useCart((s) => s.ids);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  // Shipping choice — lazy-init from sessionStorage (SSR-safe via typeof window guard)
  const [ship, setShip] = useState<ShipId>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('acc_ship');
      if (saved === 'kurier' || saved === 'odbior') return saved;
    }
    return 'kurier';
  });

  // Confirmation state — null while still shopping, set at checkout time
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // Stable random order number (generated once)
  const [orderNo] = useState(() => 'ACC-' + (1000 + Math.floor(Math.random() * 9000)));

  // Persist ship choice to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('acc_ship', ship);
  }, [ship]);

  // Clear cart once on confirmation mount
  useEffect(() => {
    if (confirm === null) return;
    clear();
  }, [confirm, clear]);

  const products = resolveCartProducts(ids);
  const n = products.length;
  const subtotal = products.reduce((s, p) => s + p.price, 0);
  const shipCost = ship === 'odbior' ? 0 : 18;
  const total = subtotal + shipCost;

  function handlePickShip(id: ShipId) {
    setShip(id);
  }

  function handleCheckout() {
    // Snapshot n and total BEFORE clear() — see shop.js checkout() which reads
    // items.length and cartTotal() before clearing.
    setConfirm({ n, total, orderNo });
  }

  // ── Confirmation screen ─────────────────────────────────────────────────
  if (confirm !== null) {
    return (
      <div className="confirm">
        <div className="seal">
          <Icon name="check" />
        </div>
        <div className="eyebrow" style={{ justifyContent: 'center' }}>
          {t('confirm.eyebrow')}
        </div>
        <h1 style={{ marginTop: 18 }}>
          {t.rich('confirm.h', richTags)}
        </h1>
        <p>{t('confirm.p1')}</p>
        <p>
          {t('confirm.order')}{' '}
          <b>{confirm.n} {t('confirm.word', { count: confirm.n })}</b>{' '}
          {t('confirm.worth')}{' '}
          <b>{euro(confirm.total)}</b>{' '}
          {t('confirm.tail')}
        </p>
        <div className="order-no">
          {t('confirm.orderno')} {confirm.orderNo}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/" className="btn btn-primary">
            {t('confirm.back')} <Icon name="arrow" />
          </Link>
          <Link href="/kubki" className="btn btn-ghost">
            {t('confirm.more')}
          </Link>
        </div>
      </div>
    );
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
                  <span className="price">{euro(p.price)}</span>
                  <button className="rm" onClick={() => remove(p.id)}>
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
          <span className="v">{euro(subtotal)}</span>
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
          <span className="v">{shipCost > 0 ? euro(shipCost) : t('cart.free')}</span>
        </div>
        <div className="sum-total">
          <span className="k">{t('cart.total')}</span>
          <span className="v">{euro(total)}</span>
        </div>
        <button className="btn btn-primary" id="checkout" onClick={handleCheckout}>
          {t('cart.checkout')} <Icon name="arrow" />
        </button>
        <p className="fineprint">
          {t.rich('cart.fineprint', richTags)}
        </p>
      </aside>
    </div>
  );
}
