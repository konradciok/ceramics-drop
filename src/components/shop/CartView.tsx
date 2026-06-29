'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { useCart } from '@/store/cart';
import { CATEGORIES } from '@/lib/products';
import { resolveCartLines, type CartLine } from '@/lib/cart-lines';
import { priceOfVariant } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import { pln, eur, gbp } from '@/lib/format';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { Link } from '@/i18n/navigation';
import {
  analyticsItemsForIds,
  buildEngagementEvent,
  buildRemoveFromCartEvent,
  buildViewCartEventFromItems,
  pushDataLayer,
} from '@/lib/analytics';
import {
  forgetRememberedCheckout,
  pushCheckoutStartedItems,
  rememberCheckoutForReturn,
} from '@/lib/checkout-analytics';
import { collectMarketingCookies } from '@/lib/marketing/client-cookies';
import { sha256Hex } from '@/lib/marketing/hash';
import { srcSet } from '@/lib/images';
import { SHIPPING_PLN, SHIPPING_EUR, SHIPPING_GBP, PRICE_EUR, PRICE_GBP, type DeliveryMethod } from '@/lib/pricing';
import { CheckoutForm } from './CheckoutForm';
import { GeowidgetPicker, type SelectedPoint } from './GeowidgetPicker';

/**
 * Cart / checkout screen. InPost is the sole carrier: the buyer picks a
 * Paczkomat (Geowidget), a courier address, or free studio pickup, and the
 * receiver contact is collected here — before payment — so the shipment can be
 * created automatically once the order is paid.
 */

type ShipId = DeliveryMethod;

const SHIP_IDS: ShipId[] = ['paczkomat', 'kurier', 'odbior'];

// Maps each delivery method to its funnel event so we can see which option
// creates friction vs. advantage (InPost locker vs. courier vs. Warsaw pickup).
const SHIP_EVENT: Record<ShipId, string> = {
  paczkomat: 'parcel_locker_select',
  kurier: 'courier_select',
  odbior: 'pickup_select',
};

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
      data-testid={`shipping-${id}`}
      onClick={() => onPick(id)}
      role="radio"
      aria-checked={active}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); // Space would otherwise scroll the page
          onPick(id);
        }
      }}
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
  { key: 'seeMidvases',   href: '/wazony-srednie' },
  { key: 'seeBigvases',   href: '/wazony-duze' },
  { key: 'seeDishes',     href: '/talerzyki' },
  { key: 'seeMedplates',  href: '/talerze-srednie' },
  { key: 'seePlates',     href: '/talerze-duze' },
  { key: 'seeLargebowls', href: '/duze-michy' },
  { key: 'seeWavybowls',  href: '/miski-falowane' },
];

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CartView({ privateSaleToken: propSaleToken }: { privateSaleToken?: string | null } = {}) {
  const t = useTranslations();
  const locale = useLocale();
  const ids = useCart((s) => s.ids);
  const remove = useCart((s) => s.remove);
  const replace = useCart((s) => s.replace);

  // Private-sale mode: driven solely by the `?sale=<TOKEN>` URL param (passed in from
  // the server component). The cart is a locked bundle of (already-`sold`) pieces:
  // seeded from the link, not pruned against inventory, and not editable.
  const saleToken = propSaleToken ?? null;
  const privateSale = saleToken !== null;
  const [privateSaleError, setPrivateSaleError] = useState(false);
  // True until the bundle fetch settles, so we show a placeholder instead of briefly
  // flashing the normal empty-cart state while the cart is still empty.
  const [privateSaleLoading, setPrivateSaleLoading] = useState<boolean>(propSaleToken != null);

  // Shipping choice — lazy-init from sessionStorage (SSR-safe via typeof window guard)
  const [ship, setShip] = useState<ShipId>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('acc_ship');
      if (saved && (SHIP_IDS as string[]).includes(saved)) return saved as ShipId;
    }
    return 'paczkomat';
  });

  // Receiver contact (all methods) + courier address + selected Paczkomat.
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [address, setAddress] = useState({ street: '', building: '', city: '', postCode: '' });
  const [locker, setLocker] = useState<SelectedPoint | null>(null);

  const viewedCartKeys = useRef(new Set<string>());
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Persist ship choice to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('acc_ship', ship);
  }, [ship]);

  // On mount: private sale → seed the cart from the link's bundle; normal cart → prune sold items.
  useEffect(() => {
    if (saleToken !== null) {
      // privateSaleLoading starts true when entering private mode; flip it off once settled.
      fetch(`/api/private-sale?token=${encodeURIComponent(saleToken)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('invalid'))))
        .then(({ product_ids }: { product_ids: string[] }) => { replace(product_ids); })
        .catch(() => setPrivateSaleError(true))
        .finally(() => setPrivateSaleLoading(false));
      return;
    }
    // Drop any stored id that can never resolve to a buyable line — malformed or
    // withdrawn print tokens, unknown ceramics — so the persisted cart can't drift
    // from what's rendered (server validateCart stays the hard gate regardless).
    const current = useCart.getState().ids;
    const valid = new Set(resolveCartLines(current).map((l) => l.id));
    current.forEach((id) => { if (!valid.has(id)) remove(id); });

    fetch('/api/inventory')
      .then((r) => r.json())
      .then(({ sold }: { sold: string[] }) => sold.forEach((id) => { if (useCart.getState().ids.includes(id)) remove(id); }))
      .catch(() => {});
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = resolveCartLines(ids);
  const n = lines.length;
  const currency = locale === 'pl' ? 'pln' : locale === 'gb' ? 'gbp' : 'eur';
  const analyticsCurrency = currency === 'pln' ? 'PLN' as const : currency === 'gbp' ? 'GBP' as const : 'EUR' as const;
  const fmt = currency === 'eur' ? eur : currency === 'gbp' ? gbp : pln;
  const priceOfLine = (l: CartLine) =>
    l.kind === 'print'
      ? priceOfVariant(l.sel, currency)
      : currency === 'eur'
        ? PRICE_EUR[l.product.category]
        : currency === 'gbp'
          ? PRICE_GBP[l.product.category]
          : l.product.price;
  const shippingOf = (method: ShipId) =>
    currency === 'eur' ? SHIPPING_EUR[method] : currency === 'gbp' ? SHIPPING_GBP[method] : SHIPPING_PLN[method];
  const subtotal = lines.reduce((s, l) => s + priceOfLine(l), 0);
  const shipCost = shippingOf(ship);
  const total = subtotal + shipCost;
  const cartKey = lines.map((l) => l.id).join('|');

  useEffect(() => {
    if (lines.length === 0 || viewedCartKeys.current.has(cartKey)) return;
    viewedCartKeys.current.add(cartKey);
    const items = analyticsItemsForIds(lines.map((l) => l.id), lines.map(priceOfLine));
    pushDataLayer(buildViewCartEventFromItems(items, { currency: analyticsCurrency }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, lines]);

  function handlePickShip(id: ShipId) {
    // Fire only on an actual change — re-clicking the active option must not
    // double-count the selection.
    if (id === ship) return;
    pushDataLayer(buildEngagementEvent(SHIP_EVENT[id], { method: id, page: 'cart' }));
    setShip(id);
  }

  // Client-side gate: the InPost shipment needs the right fields per method.
  const contactReady =
    contact.firstName.trim() !== '' &&
    contact.lastName.trim() !== '' &&
    EMAIL_RE.test(contact.email.trim());
  const phoneReady = ship === 'odbior' || contact.phone.trim() !== '';
  const lockerReady = ship !== 'paczkomat' || locker !== null;
  const addressReady =
    ship !== 'kurier' ||
    (address.street.trim() !== '' &&
      address.building.trim() !== '' &&
      address.city.trim() !== '' &&
      address.postCode.trim() !== '');
  const deliveryReady = contactReady && phoneReady && lockerReady && addressReady;

  function deliveryBody() {
    return {
      locale,
      delivery_method: ship,
      contact: {
        first_name: contact.firstName.trim(),
        last_name: contact.lastName.trim(),
        email: contact.email.trim(),
        phone: contact.phone.trim(),
      },
      ...(ship === 'paczkomat' && locker ? { target_point: locker.name } : {}),
      ...(ship === 'kurier'
        ? {
            address: {
              street: address.street.trim(),
              building_number: address.building.trim(),
              city: address.city.trim(),
              post_code: address.postCode.trim(),
              country_code: 'PL',
            },
          }
        : {}),
    };
  }

  async function handleCheckout() {
    // Guard against a double-click: a second in-flight /api/checkout would
    // 409 against this buyer's own fresh reservation and silently strip the
    // items from their cart.
    if (lines.length === 0 || submitting || !deliveryReady) return;
    setSubmitting(true);
    setCheckoutError(null);
    forgetRememberedCheckout();
    const emailNorm = contact.email.trim().toLowerCase();
    const em = emailNorm ? await sha256Hex(emailNorm) : undefined;
    // begin_checkout itemises the whole cart (ceramics + prints); print items are
    // resolved from their tokens with server-equal prices.
    const checkoutItems = analyticsItemsForIds(lines.map((l) => l.id), lines.map(priceOfLine));
    pushCheckoutStartedItems(checkoutItems, {
      shippingCost: shipCost,
      shippingMethod: ship,
      userData: em ? { em } : undefined,
      currency: analyticsCurrency,
    });
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Send EVERY line id — bare ceramic ids and print tokens alike; the server
        // (validateCart) resolves and prices both.
        body: JSON.stringify({ ids: lines.map((l) => l.id), ...deliveryBody(), marketing_cookies: collectMarketingCookies(), ...(privateSale && saleToken ? { private_sale_token: saleToken } : {}) }),
      });
      if (res.status === 409) {
        const { sold } = (await res.json()) as { sold: string[] };
        sold.forEach((id) => remove(id));
        pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'sold_out', status: 409, sold_count: sold.length }));
        setCheckoutError(t('cart.soldOut'));
        return;
      }
      if (res.status === 429) {
        // Too many checkout attempts — show a wait-and-retry message rather than
        // the generic "payment failed", which would invite rapid retries.
        pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'rate_limited', status: 429 }));
        setCheckoutError(t('cart.rateLimited'));
        return;
      }
      if (!res.ok) {
        pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'checkout_failed', status: res.status }));
        setCheckoutError(t('cart.checkoutError'));
        return;
      }
      const { client_secret } = (await res.json()) as { client_secret: string };
      // Snapshot EVERY line id (+ price) so /koszyk/return fires a complete purchase
      // event for print-only and mixed carts (and never false-alarms a "purchase gap").
      rememberCheckoutForReturn(lines.map((l) => l.id), {
        shippingCost: shipCost,
        shippingMethod: ship,
        currency: analyticsCurrency,
        itemPrices: lines.map(priceOfLine),
        userData: em ? { em } : undefined,
      });
      setClientSecret(client_secret);
    } catch {
      pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'network_error', status: 0 }));
      setCheckoutError(t('cart.checkoutError'));
    } finally {
      setSubmitting(false);
    }
  }

  // Stripe redirects back to the locale-prefixed return page so the buyer's
  // language survives the round-trip. PL is the default locale (no prefix).
  const returnUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${locale === 'pl' ? '' : `/${locale}`}/koszyk/return`
      : '/koszyk/return';

  // ── Seeding a private-sale bundle ──────────────────────────────────────────
  if (privateSale && privateSaleLoading) {
    return <div className="cart-empty" aria-busy="true" />;
  }

  // ── Invalid / expired private-sale link ───────────────────────────────────
  if (privateSale && privateSaleError) {
    return (
      <div className="cart-empty">
        <h2>{t('cart.privateSaleInvalid')}</h2>
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

  const priceLabel = (id: ShipId) => {
    if (id === 'paczkomat') return t('ship.paczkomatPrice', { price: fmt(shippingOf('paczkomat')) });
    return shippingOf(id) > 0 ? fmt(shippingOf(id)) : t('cart.free');
  };

  // Stripe Elements UI in the buyer's language. de is a valid Stripe locale; gb maps to en.
  const stripeLocale = locale === 'gb' ? 'en'
    : (['pl', 'en', 'es', 'de'] as string[]).includes(locale)
      ? (locale as 'pl' | 'en' | 'es' | 'de')
      : 'auto';

  // ── Filled cart ──────────────────────────────────────────────────────────
  return (
    <div className="cart-wrap">

      {/* ── LEFT: task flow (heading, items, form, CTA) ────────────────── */}
      <div className="cart-main">
        <div className="cart-head">
          <div className="eyebrow">{t('cart.eyebrow')}</div>
          <h1>
            {t('cart.label')} <em>—</em> {n} {t('cart.word', { count: n })}
          </h1>
        </div>
        <div className="cart-list">
          {lines.map((l) => {
            if (l.kind === 'print') {
              const d = l.design;
              const name = `${t('product.print')} Nº ${d.num}`;
              return (
                <div key={l.id} className="cart-row" data-testid="cart-line" data-product-id={l.id}>
                  <Link href={`/fine-art-prints/${d.id}`} className="thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={d.image} srcSet={srcSet(d.image)} sizes="(min-width:561px) 96px, 72px" alt="" />
                  </Link>
                  <div>
                    <h4>{name}</h4>
                    <div className="meta">{variantLabel(l.sel, locale)}</div>
                  </div>
                  <div className="right">
                    <span className="price">{fmt(priceOfLine(l))}</span>
                    <button className="rm" onClick={() => remove(l.id)}>
                      <Icon name="trash" /> {t('cart.remove')}
                    </button>
                  </div>
                </div>
              );
            }
            const p = l.product;
            const cat = CATEGORIES[p.category];
            const name = t(`product.${cat.singularKey}` as Parameters<typeof t>[0]);
            return (
              <div key={l.id} className="cart-row" data-testid="cart-line" data-product-id={p.id}>
                <Link href={`/${p.category}`} className="thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} srcSet={srcSet(p.image)} sizes="(min-width:561px) 96px, 72px" alt="" />
                </Link>
                <div>
                  <h4>{name} Nº {p.num}</h4>
                  <div className="meta">{name} {t('cart.oneoff')}</div>
                </div>
                <div className="right">
                  <span className="price">{fmt(priceOfLine(l))}</span>
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

        {!clientSecret && (
          <div className="cart-section">
            <div className="cart-section-label">{t('cart.delivery')}</div>
            <div className="ship-opts" role="radiogroup" aria-label={t('cart.delivery')}>
              <ShipOption
                id="paczkomat"
                active={ship === 'paczkomat'}
                onPick={handlePickShip}
                title={t('ship.paczkomatT')}
                desc={t('ship.paczkomatD')}
                price={priceLabel('paczkomat')}
              />
              <ShipOption
                id="kurier"
                active={ship === 'kurier'}
                onPick={handlePickShip}
                title={t('ship.courierT')}
                desc={t('ship.courierD')}
                price={priceLabel('kurier')}
              />
              <ShipOption
                id="odbior"
                active={ship === 'odbior'}
                onPick={handlePickShip}
                title={t('ship.pickupT')}
                desc={t('ship.pickupD')}
                price={priceLabel('odbior')}
              />
            </div>
          </div>
        )}

        {!clientSecret && (
          <div className="cart-section">
            <div className="cart-section-label">{t('cart.deliveryDetails')}</div>
            <div className="delivery-fields">
              <div className="field-row">
                <label className="field">
                  <span>{t('delivery.firstName')}</span>
                  <input
                    value={contact.firstName}
                    onChange={(e) => setContact((c) => ({ ...c, firstName: e.target.value }))}
                    autoComplete="given-name"
                  />
                </label>
                <label className="field">
                  <span>{t('delivery.lastName')}</span>
                  <input
                    value={contact.lastName}
                    onChange={(e) => setContact((c) => ({ ...c, lastName: e.target.value }))}
                    autoComplete="family-name"
                  />
                </label>
              </div>
              <label className="field">
                <span>{t('delivery.email')}</span>
                <input
                  type="email"
                  value={contact.email}
                  onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
                  autoComplete="email"
                />
              </label>
              {ship !== 'odbior' && (
                <label className="field">
                  <span>{t('delivery.phone')}</span>
                  <input
                    type="tel"
                    value={contact.phone}
                    onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
                    autoComplete="tel"
                  />
                </label>
              )}

              {ship === 'paczkomat' && (
                <div className="locker-pick">
                  {locker && (
                    <p className="locker-chosen" data-testid="selected-locker">
                      {t('delivery.lockerChosen')} <strong>{locker.name}</strong>
                    </p>
                  )}
                  <GeowidgetPicker
                    onSelect={(p) => {
                      // Completion signal: the buyer got through InPost locker
                      // selection (vs. merely picking the paczkomat method in A1).
                      pushDataLayer(
                        buildEngagementEvent('parcel_locker_point_selected', { locker_name: p.name }),
                      );
                      setLocker(p);
                    }}
                    language={locale}
                    unavailableLabel={t('delivery.lockerUnavailable')}
                  />
                </div>
              )}

              {ship === 'kurier' && (
                <>
                  <div className="field-row">
                    <label className="field" style={{ flex: 2 }}>
                      <span>{t('delivery.street')}</span>
                      <input
                        value={address.street}
                        onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))}
                        autoComplete="address-line1"
                      />
                    </label>
                    <label className="field" style={{ flex: 1 }}>
                      <span>{t('delivery.building')}</span>
                      <input
                        value={address.building}
                        onChange={(e) => setAddress((a) => ({ ...a, building: e.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="field-row">
                    <label className="field" style={{ flex: 1 }}>
                      <span>{t('delivery.postCode')}</span>
                      <input
                        value={address.postCode}
                        onChange={(e) => setAddress((a) => ({ ...a, postCode: e.target.value }))}
                        autoComplete="postal-code"
                      />
                    </label>
                    <label className="field" style={{ flex: 2 }}>
                      <span>{t('delivery.city')}</span>
                      <input
                        value={address.city}
                        onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                        autoComplete="address-level2"
                      />
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="cart-cta">
          {!clientSecret && (
            <div className="cart-cta-total">
              <span className="k">{t('cart.total')}</span>
              <span className="v">{fmt(total)}</span>
            </div>
          )}
          {clientSecret ? (
            <Elements stripe={stripePromise} options={{ clientSecret, locale: stripeLocale }}>
              <CheckoutForm returnUrl={returnUrl} />
            </Elements>
          ) : (
            <button
              className="btn btn-primary"
              id="checkout"
              data-testid="checkout-button"
              onClick={handleCheckout}
              disabled={submitting || !deliveryReady}
            >
              {t('cart.checkout')} <Icon name="arrow" />
            </button>
          )}
          {checkoutError && <p className="pay-error">{checkoutError}</p>}
          <p className="fineprint">
            {t.rich('cart.fineprint', richTags)}
          </p>
        </div>
      </div>

      {/* ── RIGHT: sticky order summary ─────────────────────────────────── */}
      <aside className="summary">
        <h3>{t('cart.summary')}</h3>
        <ul className="sum-items">
          {lines.map((l) => {
            if (l.kind === 'print') {
              const d = l.design;
              return (
                <li key={l.id} className="sum-item">
                  <Link href={`/fine-art-prints/${d.id}`} className="sum-item-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={d.image} srcSet={srcSet(d.image)} sizes="56px" alt="" />
                  </Link>
                  <div className="sum-item-info">
                    <span className="sum-item-name">{t('product.print')} Nº {d.num} · {variantLabel(l.sel, locale)}</span>
                    <span className="sum-item-price">{fmt(priceOfLine(l))}</span>
                  </div>
                </li>
              );
            }
            const p = l.product;
            const cat = CATEGORIES[p.category];
            const name = t(`product.${cat.singularKey}` as Parameters<typeof t>[0]);
            return (
              <li key={l.id} className="sum-item">
                <Link href={`/${p.category}`} className="sum-item-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} srcSet={srcSet(p.image)} sizes="56px" alt="" />
                </Link>
                <div className="sum-item-info">
                  <span className="sum-item-name">{name} Nº {p.num}</span>
                  <span className="sum-item-price">{fmt(priceOfLine(l))}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="sum-row">
          <span className="k">{t('cart.pieces')} ({n})</span>
          <span className="v">{fmt(subtotal)}</span>
        </div>
        <div className="sum-row">
          <span className="k">{t('cart.delivery')}</span>
          <span className="v">{shipCost > 0 ? fmt(shipCost) : t('cart.free')}</span>
        </div>
        <div className="sum-total">
          <span className="k">{t('cart.total')}</span>
          <span className="v">{fmt(total)}</span>
        </div>
        <div className="cart-delivery-notice">
          <strong>{t('deliveryNotice.title')}</strong>
          <p>{t('deliveryNotice.p1')}</p>
          <p>{t('deliveryNotice.p2')}</p>
          <p>{t('deliveryNotice.p3')}</p>
        </div>
      </aside>
    </div>
  );
}
