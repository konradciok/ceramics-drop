'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Elements } from '@stripe/react-stripe-js';
import { getStripe } from '@/lib/stripe-client';
import { useCart } from '@/store/cart';
import { CATEGORIES, registryProductById, isCategoryHidden } from '@/lib/products';
import { resolveCartLines, type CartLine } from '@/lib/cart-lines';
import { priceOfVariant } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { Link } from '@/i18n/navigation';
import { useStripUrlParams } from '@/lib/use-strip-url-token';
import {
  analyticsItemsForIds,
  buildEngagementEvent,
  buildPrintRemoveFromCartEvent,
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
import { priceOfCurrency, shippingOfCurrency, type DeliveryMethod } from '@/lib/pricing';
import { PRINT_COUNTRIES, printShippingOf, type PrintCountry } from '@/lib/print-shipping';
import { checkoutPreBodyError, shouldKeepAttemptIdOnCatch } from '@/lib/checkout-client';
import { useMounted } from '@/lib/use-mounted';
import { CheckoutForm } from './CheckoutForm';
import { GeowidgetPicker, type SelectedPoint } from './GeowidgetPicker';
import { PrintDeliveryForm, PRINT_DELIVERY_FORM_ID } from './PrintDeliveryForm';
import type { PrintDeliveryContact, PrintShippingAddress } from '@/lib/print-delivery';

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

const stripePromise = getStripe();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stable id for one checkout attempt, sent to /api/checkout so a retried POST
// (network retry, second tab sharing the same localStorage cart) re-enters
// its own reservation/PaymentIntent instead of 409-ing itself. Persisted
// alongside the cart (acc_cart_v1) so it survives a page reload of the same
// attempt; reset whenever the cart contents change or a checkout succeeds.
const ATTEMPT_ID_KEY = 'acc_checkout_attempt_v1';

function readOrCreateAttemptId(): string {
  if (typeof window === 'undefined') return '';
  const saved = localStorage.getItem(ATTEMPT_ID_KEY);
  if (saved) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem(ATTEMPT_ID_KEY, id);
  return id;
}

export function CartView({
  privateSaleToken: propSaleToken,
  initialPrintCountry = 'PL',
}: {
  privateSaleToken?: string | null;
  initialPrintCountry?: PrintCountry;
} = {}) {
  const t = useTranslations();
  const locale = useLocale();
  const mounted = useMounted();
  const ids = useCart((s) => s.ids);
  const remove = useCart((s) => s.remove);
  const replace = useCart((s) => s.replace);

  // Private-sale mode: driven solely by the `?sale=<TOKEN>` URL param (passed in from
  // the server component). The cart is a locked bundle of (already-`sold`) pieces:
  // seeded from the link, not pruned against inventory, and not editable.
  const saleToken = propSaleToken ?? null;
  // N-1: scrub the single-use ?sale= token from the URL now that the server has
  // handed it to us as a prop — keeps it out of gtag's ambient page_location,
  // browser history, and the Referer header. Private-sale mode is already seeded
  // from propSaleToken, so a later hard reload intentionally drops to the normal cart.
  useStripUrlParams(['sale']);
  const privateSale = saleToken !== null;
  const [privateSaleError, setPrivateSaleError] = useState(false);
  // True until the bundle fetch settles, so we show a placeholder instead of briefly
  // flashing the normal empty-cart state while the cart is still empty.
  const [privateSaleLoading, setPrivateSaleLoading] = useState<boolean>(propSaleToken != null);

  // Shipping choice — lazy-init from sessionStorage (SSR-safe via typeof window guard)
  const [shipChoice, setShipChoice] = useState<ShipId>(() => {
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
  // The InPost map is heavy (400px+ on phones) and used to sit between the
  // fields and the pay CTA unconditionally. It now mounts only on explicit
  // intent and collapses back to the chosen point after selection.
  const [lockerMapOpen, setLockerMapOpen] = useState(false);
  // Destination country — print carts only (Prodigi ships EU + UK); ceramics are PL/InPost.
  const [country, setCountry] = useState<PrintCountry>(initialPrintCountry);

  const viewedCartKeys = useRef(new Set<string>());
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attemptId, setAttemptId] = useState<string>(() => readOrCreateAttemptId());

  function resetAttemptId() {
    const id = crypto.randomUUID();
    localStorage.setItem(ATTEMPT_ID_KEY, id);
    setAttemptId(id);
  }

  // Persist the buyer's own choice (not the print-forced kurier override).
  useEffect(() => {
    sessionStorage.setItem('acc_ship', shipChoice);
  }, [shipChoice]);

  // On mount: private sale → seed the cart from the link's bundle; normal cart → prune sold items.
  useEffect(() => {
    if (saleToken !== null) {
      // privateSaleLoading starts true when entering private mode; flip it off once settled.
      fetch(`/api/private-sale?token=${encodeURIComponent(saleToken)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('invalid'))))
        .then(({ product_ids }: { product_ids: string[] }) => {
          const hasHidden = product_ids.some((id) => {
            const p = registryProductById(id);
            return p !== undefined && isCategoryHidden(p.category);
          });
          if (hasHidden) { setPrivateSaleError(true); return; }
          replace(product_ids);
        })
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
      .then(({ sold, showroom = [] }: { sold: string[]; showroom?: string[] }) =>
        // Prune anything no longer purchasable — sold pieces and showroom-retired
        // pieces alike — exactly as the server reserve_pieces guard would reject.
        [...sold, ...showroom].forEach((id) => { if (useCart.getState().ids.includes(id)) remove(id); }))
      .catch(() => {});
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = resolveCartLines(ids);
  const n = lines.length;
  // Prints are fulfilled by Prodigi to a home address — a locker or studio pickup
  // can't carry them, so any cart with a print line is locked to courier delivery
  // (the checkout API enforces the same rule server-side).
  const hasPrints = lines.some((l) => l.kind === 'print');
  const hasCeramics = lines.some((l) => l.kind === 'ceramic');
  // Hard rule: ceramics (drops + InPost) and prints (Prodigi) are separate orders.
  const mixedCart = hasPrints && hasCeramics;
  // Private-sale links re-offer sold ceramics only; a print-only cart on that URL
  // (e.g. buyer removed seeded pieces and added prints) cannot checkout.
  const privateSalePrints = privateSale && hasPrints;
  const hasFramed = lines.some((l) => l.kind === 'print' && l.sel.framed);
  const ship: ShipId = hasPrints ? 'kurier' : shipChoice;
  const currency = useCurrency();
  // priceOfVariant / printShippingOf only price pln/eur/gbp; toChargeableCurrency
  // maps any other currency to EUR.
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(currency);
  const priceOfLine = (l: CartLine) =>
    l.kind === 'print'
      ? priceOfVariant(l.design, l.sel, printCurrency)
      : priceOfCurrency(l.product, currency);
  const shippingOf = (method: ShipId) => shippingOfCurrency(currency, method);
  const subtotal = lines.reduce((s, l) => s + priceOfLine(l), 0);
  // Print carts charge Prodigi's shipping cost by destination country;
  // ceramic carts keep the InPost price list.
  const shipCost = hasPrints ? printShippingOf(country, hasFramed, printCurrency) : shippingOf(ship);
  const total = subtotal + shipCost;
  // Localized country names for the print destination selector, sorted A→Z.
  const regionNames = new Intl.DisplayNames([locale], { type: 'region' });
  const countryOptions = PRINT_COUNTRIES
    .map((code) => ({ code, name: regionNames.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const cartKey = lines.map((l) => l.id).join('|');

  // The cart changing (add/remove) means this is a different purchase intent
  // than whatever was persisted — regenerate so a stale attemptId is never
  // reused across unrelated carts. Skips the initial mount (same attempt).
  const attemptCartKey = useRef(cartKey);
  useEffect(() => {
    if (attemptCartKey.current === cartKey) return;
    attemptCartKey.current = cartKey;
    const id = crypto.randomUUID();
    localStorage.setItem(ATTEMPT_ID_KEY, id);
    setAttemptId(id);
  }, [cartKey]);

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
    setShipChoice(id);
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
  const deliveryReady = hasPrints || (contactReady && phoneReady && lockerReady && addressReady);

  function deliveryBody(printDelivery?: { contact: PrintDeliveryContact; address: PrintShippingAddress }) {
    if (hasPrints && printDelivery) {
      return { locale, delivery_method: 'kurier' as const, ...printDelivery };
    }
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
              // InPost kurier is domestic; Prodigi ships prints EU + UK.
              country_code: hasPrints ? country : 'PL',
            },
          }
        : {}),
    };
  }

  async function handleCheckout(printDelivery?: { contact: PrintDeliveryContact; address: PrintShippingAddress }) {
    // Guard against a double-click: a second in-flight /api/checkout would
    // 409 against this buyer's own fresh reservation and silently strip the
    // items from their cart.
    if (lines.length === 0 || submitting || !deliveryReady || mixedCart || privateSalePrints) return;
    setSubmitting(true);
    setCheckoutError(null);
    forgetRememberedCheckout();
    const emailNorm = (printDelivery?.contact.email ?? contact.email).trim().toLowerCase();
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
    // Tracks whether the server actually answered. On any received failure the
    // attemptId must be abandoned (Stripe caches the FIRST response — even an
    // error — per idempotency key for ~24h, so retrying the same key would just
    // replay the failure). But when NO response arrived, the POST may have gone
    // through server-side, and keeping the attemptId is what lets the next
    // click replay onto its own reservation instead of 409-ing it.
    let gotResponse = false;
    let resOk = false;
    let resStatus = 0;
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Send EVERY line id — bare ceramic ids and print tokens alike; the server
        // (validateCart) resolves and prices both.
        body: JSON.stringify({ ids: lines.map((l) => l.id), attemptId, ...deliveryBody(printDelivery), marketing_cookies: collectMarketingCookies(), ...(privateSale && saleToken ? { private_sale_token: saleToken } : {}) }),
      });
      gotResponse = true;
      resOk = res.ok;
      resStatus = res.status;
      if (res.status === 409) {
        const conflict = (await res.json()) as { error?: string; sold?: string[] };
        if (conflict.error === 'order_conflict') {
          // The attemptId was already consumed by a non-pending order (paid,
          // expired, ...). Start a fresh attempt for the next click and keep
          // the cart intact — nothing here is sold out.
          resetAttemptId();
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'order_conflict', status: 409 }));
          setCheckoutError(t('cart.checkoutError'));
          return;
        }
        if (conflict.error === 'checkout_in_progress') {
          // Another POST with this same attemptId is mid-flight (double-click,
          // second tab) or its outcome couldn't be read. KEEP the attemptId —
          // a retry click replays onto the winning checkout instead of starting
          // a fresh attempt that would 409 against its own live hold.
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'checkout_in_progress', status: 409 }));
          setCheckoutError(t('cart.checkoutError'));
          return;
        }
        if (conflict.error === 'print_asset_unavailable') {
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'print_asset_unavailable', status: 409 }));
          setCheckoutError(t('cart.printAssetUnavailable'));
          return;
        }
        const sold = conflict.sold ?? [];
        sold.forEach((id) => remove(id));
        pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'sold_out', status: 409, sold_count: sold.length }));
        setCheckoutError(t('cart.soldOut'));
        return;
      }
      if (res.status === 429 || res.status === 503) {
        let body: { error?: string } | undefined;
        if (res.status === 503) {
          try {
            body = (await res.json()) as { error?: string };
          } catch {
            // Bare 503 from checkout is unambiguous.
          }
        }
        const preBody = checkoutPreBodyError(res.status, body);
        if (preBody) {
          pushDataLayer(buildEngagementEvent('checkout_error', {
            reason: preBody.analyticsReason,
            status: preBody.analyticsStatus,
          }));
          setCheckoutError(t(preBody.errorKey));
          return;
        }
      }
      if (!res.ok) {
        // Abandon the attemptId: Stripe may have cached this failure under its
        // idempotency key, and the server already released any hold it took —
        // a fresh attempt is the only path that can succeed.
        resetAttemptId();
        let reason = 'checkout_failed';
        let errorMessage = t('cart.checkoutError');
        if (res.status === 400) {
          try {
            const body = (await res.json()) as { error?: string };
            if (body.error === 'private_sale_prints_unsupported') {
              reason = 'private_sale_prints_unsupported';
              errorMessage = t('cart.privateSalePrintsNotice');
            }
          } catch {
            // Unparseable body — keep generic copy.
          }
        }
        pushDataLayer(buildEngagementEvent('checkout_error', { reason, status: res.status }));
        setCheckoutError(errorMessage);
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
      // A later, separate purchase must never reuse this attemptId.
      resetAttemptId();
      setClientSecret(client_secret);
    } catch {
      // An ERROR response we failed to process is a received failure → fresh
      // attempt (Stripe may have cached that failure under the key). But a 200
      // whose body failed to process means the checkout SUCCEEDED server-side:
      // keep the attemptId so the next click replays the same client_secret.
      // A 409 whose body we couldn't read is also kept: it may have been
      // checkout_in_progress/unavailable (keep-required), and a kept id
      // converges on retry while a wrong reset wipes the cart against the
      // buyer's own live hold. A pure network error also keeps it — see above.
      if (gotResponse && !resOk && !shouldKeepAttemptIdOnCatch(resStatus)) resetAttemptId();
      // Received-but-unprocessable responses are not network errors — report
      // the real status so analytics can tell a parse failure from an outage.
      pushDataLayer(buildEngagementEvent(
        'checkout_error',
        gotResponse
          ? { reason: 'response_parse_error', status: resStatus }
          : { reason: 'network_error', status: 0 },
      ));
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

  // ── Awaiting hydration ─────────────────────────────────────────────────────
  // Server HTML has no localStorage cart, so rendering the real empty/filled
  // state before hydration flashes "cart is empty" at every visitor with items
  // (and trips a React hydration mismatch). Hold a neutral placeholder until
  // the persisted store is live on the client.
  if (!mounted) {
    return <div className="cart-empty" aria-busy="true" />;
  }

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

  // Stripe Elements UI in the buyer's language. de is a valid Stripe locale.
  const stripeLocale = (['pl', 'en', 'es', 'de'] as string[]).includes(locale)
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
                  <Link href={`/fine-art-prints/${d.id}`} className="thumb" aria-label={name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={d.image} srcSet={srcSet(d.image)} sizes="(min-width:561px) 96px, 72px" alt="" />
                  </Link>
                  <div>
                    <h4>{name}</h4>
                    <div className="meta">{variantLabel(l.sel, locale)}</div>
                  </div>
                  <div className="right">
                    <span className="price">{fmt(priceOfLine(l))}</span>
                    <button
                      className="rm"
                      onClick={() => {
                        remove(l.id);
                        pushDataLayer(
                          buildPrintRemoveFromCartEvent(
                            { id: d.id, num: d.num, variantLabel: variantLabel(l.sel, locale), price: priceOfLine(l) },
                            { currency: analyticsCurrency },
                          ),
                        );
                      }}
                    >
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
                <Link href={`/${p.category}/${p.id}`} className="thumb" aria-label={`${name} Nº ${p.num}`}>
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
                      pushDataLayer(
                        buildRemoveFromCartEvent(p, {
                          currency: analyticsCurrency,
                          itemPrices: [priceOfCurrency(p, currency)],
                        }),
                      );
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
              {!hasPrints && (
                <ShipOption
                  id="paczkomat"
                  active={ship === 'paczkomat'}
                  onPick={handlePickShip}
                  title={t('ship.paczkomatT')}
                  desc={t('ship.paczkomatD')}
                  price={priceLabel('paczkomat')}
                />
              )}
              <ShipOption
                id="kurier"
                active={ship === 'kurier'}
                onPick={handlePickShip}
                title={t(hasPrints ? 'ship.printT' : 'ship.courierT')}
                desc={t(hasPrints ? 'ship.printD' : 'ship.courierD')}
                price={hasPrints ? fmt(shipCost) : priceLabel('kurier')}
              />
              {!hasPrints && (
                <ShipOption
                  id="odbior"
                  active={ship === 'odbior'}
                  onPick={handlePickShip}
                  title={t('ship.pickupT')}
                  desc={t('ship.pickupD')}
                  price={priceLabel('odbior')}
                />
              )}
            </div>
          </div>
        )}

        {!clientSecret && (
          <div className="cart-section">
            <div className="cart-section-label">{t('cart.deliveryDetails')}</div>
            {hasPrints ? (
              <PrintDeliveryForm
                initialCountry={initialPrintCountry}
                countryOptions={countryOptions}
                onCountryChange={setCountry}
                onSubmit={handleCheckout}
              />
            ) : (
            <div className="delivery-fields">
              {/* All ceramic delivery methods are Poland-only (InPost / Warsaw pickup). */}
              <p className="cart-pl-only" data-testid="pl-only-note">{t('delivery.plOnly')}</p>
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
                  {lockerMapOpen ? (
                    <GeowidgetPicker
                      onSelect={(p) => {
                        // Completion signal: the buyer got through InPost locker
                        // selection (vs. merely picking the paczkomat method in A1).
                        pushDataLayer(
                          buildEngagementEvent('parcel_locker_point_selected', { locker_name: p.name }),
                        );
                        setLocker(p);
                        setLockerMapOpen(false);
                      }}
                      language={locale}
                      unavailableLabel={t('delivery.lockerUnavailable')}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost locker-toggle"
                      data-testid={locker ? 'change-locker' : 'choose-locker'}
                      onClick={() => setLockerMapOpen(true)}
                    >
                      {t(locker ? 'delivery.changeLocker' : 'delivery.chooseLocker')}
                    </button>
                  )}
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
            )}
          </div>
        )}

        <div className="cart-cta">
          {mixedCart && (
            <p className="pay-error" data-testid="mixed-cart-notice">{t('cart.mixedNotice')}</p>
          )}
          {privateSalePrints && (
            <p className="pay-error" data-testid="private-sale-prints-notice">{t('cart.privateSalePrintsNotice')}</p>
          )}
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
              type={hasPrints ? 'submit' : 'button'}
              form={hasPrints ? PRINT_DELIVERY_FORM_ID : undefined}
              onClick={hasPrints ? undefined : () => void handleCheckout()}
              disabled={submitting || !deliveryReady || mixedCart || privateSalePrints}
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
                  <Link href={`/fine-art-prints/${d.id}`} className="sum-item-thumb" aria-label={`${t('product.print')} Nº ${d.num}`}>
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
                <Link href={`/${p.category}/${p.id}`} className="sum-item-thumb" aria-label={`${name} Nº ${p.num}`}>
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
