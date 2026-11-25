'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Elements } from '@stripe/react-stripe-js';
import { getStripe } from '@/lib/stripe-client';
import { useCart } from '@/store/cart';
import { CATEGORIES, registryProductById, isCategoryHidden, productDisplayName } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import type { CartLine } from '@/lib/cart-lines-server';
import { useCartLines } from '@/lib/use-cart-lines';
import { isGiftCardToken } from '@/lib/gift-cards';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { richTags } from '@/components/ui/richTags';
import { Icon } from '@/components/ui/Icon';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { useStripUrlParams } from '@/lib/use-strip-url-token';
import {
  analyticsItemsForIds,
  buildEngagementEvent,
  buildRemoveFromCartEvent,
  buildViewCartEventFromItems,
  pushDataLayer,
} from '@/lib/analytics';
import {
  forgetRememberedCheckout,
  pushCheckoutStartedItemsOnce,
  rememberCheckoutForReturn,
} from '@/lib/checkout-analytics';
import { collectMarketingCookies } from '@/lib/marketing/client-cookies';
import { sha256Hex } from '@/lib/marketing/hash';
import { srcSet } from '@/lib/images';
import { priceOfCurrency, shippingOfCurrency, CHECKOUT_DELIVERY_METHODS, COURIER_ENABLED, STUDIO_PICKUP_ENABLED, type DeliveryMethod } from '@/lib/pricing';
import type { DestinationCountry } from '@/lib/delivery/destinations';
import type { CheckoutDestinationOption } from '@/lib/shipping-rates/delivery-rates';
import {
  attemptIdentityKey,
  cartSummaryAmounts,
  checkoutPreBodyError,
  resolveConfirmedAmounts,
  readSentMarketingOptIn,
  rememberSentMarketingOptIn,
  shouldKeepAttemptIdOnCatch,
  type CheckoutAmounts,
} from '@/lib/checkout-client';
import { useMounted } from '@/lib/use-mounted';
import { CheckoutForm } from './CheckoutForm';
import { MarketingOptInCheckbox } from './MarketingOptInCheckbox';
import { GiftCardPayment, type AppliedGiftCard } from './GiftCardPayment';
import { splitGiftCardPayment, STRIPE_MINIMUM_MINOR } from '@/lib/gift-card-balance';
import { GeowidgetPicker, type SelectedPoint } from './GeowidgetPicker';
import { SendcloudPointPicker, type SendcloudPickedPoint } from './SendcloudPointPicker';

/**
 * Cart / checkout screen. InPost is the sole carrier: the buyer picks a
 * Paczkomat (Geowidget), a courier address, or free studio pickup, and the
 * receiver contact is collected here — before payment — so the shipment can be
 * created automatically once the order is paid.
 */

type ShipId = DeliveryMethod;

// A saved choice outside this list (e.g. 'odbior' after pickup was switched off) falls back to paczkomat.
const SHIP_IDS: readonly ShipId[] = CHECKOUT_DELIVERY_METHODS;

// Maps each delivery method to its funnel event so we can see which option
// creates friction vs. advantage (InPost locker vs. courier vs. studio pickup).
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
  { key: 'seeSmallplates', href: '/talerze-male' },
  { key: 'seeMedplates',  href: '/talerze-srednie' },
  { key: 'seePlates',     href: '/talerze-duze' },
  { key: 'seeLargebowls', href: '/duze-michy' },
  { key: 'seeWavybowls',  href: '/miski-falowane' },
  { key: 'seeOvalplates', href: '/talerze-owalne' },
];

const stripePromise = getStripe();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stable id for one checkout attempt, sent to /api/checkout so a retried POST
// (network retry, second tab sharing the same localStorage cart) re-enters
// its own reservation/PaymentIntent instead of 409-ing itself. Persisted
// alongside the cart (acc_cart_v1) so it survives a page reload of the same
// attempt; reset whenever the cart contents change or a checkout succeeds.
const ATTEMPT_ID_KEY = 'acc_checkout_attempt_v1';
/** The marketing opt-in sent with ATTEMPT_ID_KEY's attempt (frozen per attempt). */
const OPT_IN_KEY = 'acc_checkout_optin_v1';

function readOrCreateAttemptId(): string {
  if (typeof window === 'undefined') return '';
  const saved = localStorage.getItem(ATTEMPT_ID_KEY);
  if (saved) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem(ATTEMPT_ID_KEY, id);
  return id;
}

// Last delivery country the buyer chose (plan §6: persisted in localStorage).
const COUNTRY_KEY = 'acc_delivery_country_v1';

function readSavedCountry(destinations: readonly CheckoutDestinationOption[]): DestinationCountry | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = localStorage.getItem(COUNTRY_KEY);
    return destinations.find((d) => d.country === saved)?.country ?? null;
  } catch {
    return null;
  }
}

export function CartView({
  privateSaleToken: propSaleToken,
  destinations,
  defaultCountry,
}: {
  privateSaleToken?: string | null;
  /**
   * The countries checkout offers, each with the SAME published shipping
   * table checkout charges from (getShippingRatesForDisplay resolved per
   * destination by the server page — client islands cannot reach the DB).
   * Required, with no code-constant default: a caller that forgot it would
   * silently show a price the CMS has since changed away from. Never empty.
   */
  destinations: CheckoutDestinationOption[];
  /** The country preselected for this visitor (defaultCheckoutCountry). */
  defaultCountry: DestinationCountry;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const mounted = useMounted();
  const ids = useCart((s) => s.ids);
  const remove = useCart((s) => s.remove);
  const replace = useCart((s) => s.replace);
  const { lines: allLines, status: linesStatus } = useCartLines(ids, locale);

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
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [address, setAddress] = useState({ street: '', building: '', city: '', postCode: '' });
  const [locker, setLocker] = useState<SelectedPoint | null>(null);
  // Delivery country, and the Sendcloud point picked for it (Sendcloud lanes).
  const [deliveryCountry, setDeliveryCountry] = useState<DestinationCountry>(
    () => readSavedCountry(destinations) ?? defaultCountry,
  );
  const [servicePoint, setServicePoint] = useState<SendcloudPickedPoint | null>(null);
  // The InPost map is heavy (400px+ on phones) and used to sit between the
  // fields and the pay CTA unconditionally. It now mounts only on explicit
  // intent and collapses back to the chosen point after selection.
  const [lockerMapOpen, setLockerMapOpen] = useState(false);

  const viewedCartKeys = useRef(new Set<string>());
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // What /api/checkout actually priced the PaymentIntent from (minor units).
  // Everything below re-computes continuously from the code-default rate
  // tables; these do not. Once `clientSecret` exists the summary renders THESE
  // — a CMS rate republish (or a currency flip) mid-payment can no longer
  // leave the buyer reading a number Stripe will not charge.
  const [confirmedAmounts, setConfirmedAmounts] = useState<CheckoutAmounts | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [availableIds, setAvailableIds] = useState<Set<string> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attemptId, setAttemptId] = useState<string>(() => readOrCreateAttemptId());
  // Opt-in already sent with this attemptId (null = nothing sent yet). While
  // set, the checkbox is locked to it — see readSentMarketingOptIn. Derived
  // per render: this page's own send wins, else the persisted one (read only
  // after mount, so SSR and hydration agree). A new attemptId unlocks it.
  const [sentOptIn, setSentOptIn] = useState<{ attemptId: string; optIn: boolean } | null>(null);
  const lockedOptIn =
    sentOptIn?.attemptId === attemptId
      ? sentOptIn.optIn
      : mounted
        ? readSentMarketingOptIn(OPT_IN_KEY, attemptId)
        : null;

  function resetAttemptId() {
    const id = crypto.randomUUID();
    localStorage.setItem(ATTEMPT_ID_KEY, id);
    setAttemptId(id);
  }

  // Applied promo: server-validated preview `{ code, discount /* minor units */ }`.
  // Display-only — checkout receives just the code string and re-validates.
  const [promo, setPromo] = useState<{ code: string; discount: number } | null>(null);
  const [promoInput, setPromoInput] = useState('');
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoBusy, setPromoBusy] = useState(false);
  // A PromoIneligibleReason from the server, or 'network' for transport failures.
  const [promoError, setPromoError] = useState<string | null>(null);
  const [giftCard, setGiftCard] = useState<AppliedGiftCard | null>(null);
  const [balancePayment, setBalancePayment] = useState<{ giftCard: number; cash: number } | null>(null);

  // Persist the buyer's delivery choice.
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
    // Fetch availability only — the prune-against-it effect below applies it
    // once the cart-lines DTO has resolved which ids are real ceramic lines
    // in the first place (see that effect's own comment for why).
    fetch('/api/inventory')
      .then((r) => { if (!r.ok) throw new Error('availability_unavailable'); return r.json(); })
      .then(({ available }: { available: string[] }) => {
        if (!Array.isArray(available)) throw new Error('availability_unavailable');
        setAvailableIds(new Set(available));
        setInventoryReady(true);
      })
      .catch(() => setInventoryReady(false));
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sold-piece pruning: silent (no buyer-visible notice — "someone else just
  // bought it" needs no explanation the way "this was never purchasable"
  // does). Gated on BOTH the inventory fetch above and the cart-lines DTO
  // being 'ready', and scoped to already-resolved `kind: 'ceramic'` lines —
  // NOT raw ids. A bare id that /api/inventory doesn't list could just as
  // easily be unknown/withdrawn/malformed, not merely sold; pruning by raw
  // id here would silently drop it before the unavailable-line effect below
  // ever saw it in `allLines`, losing the buyer-visible notice that effect
  // exists to show.
  useEffect(() => {
    if (!availableIds || linesStatus !== 'ready') return;
    allLines.forEach((l) => {
      if (l.kind === 'ceramic' && !availableIds.has(l.id)) remove(l.id);
    });
  }, [availableIds, allLines, linesStatus, remove]);

  // Auto-remove any cart id the server-side resolver could not resolve
  // (unknown, withdrawn, malformed token) with a one-time visible notice —
  // replaces the old resolver's silent-drop behavior. Fires whenever the
  // cart-lines DTO resolves/re-resolves, not just on mount, so an id that
  // becomes unavailable later (e.g. withdrawn while sitting in the cart) is
  // still caught. `handledUnavailableIds` guards against reprocessing the
  // same id on a subsequent re-render/re-fetch.
  const handledUnavailableIds = useRef(new Set<string>());
  const [showUnavailableNotice, setShowUnavailableNotice] = useState(false);
  useEffect(() => {
    if (linesStatus !== 'ready') return;
    const newlyUnavailable = allLines.filter(
      (l) => l.kind === 'unavailable' && !handledUnavailableIds.current.has(l.id),
    );
    if (newlyUnavailable.length === 0) return;
    newlyUnavailable.forEach((l) => {
      handledUnavailableIds.current.add(l.id);
      remove(l.id);
    });
    setShowUnavailableNotice(true);
  }, [allLines, linesStatus, remove]);

  // This is the ceramics merchandise cart — gift cards are their own
  // exclusive checkout track (no shipping, no mixing) with a dedicated flow,
  // so any gift-card token that ends up in the shared cart store is dropped
  // here rather than half-rendered through ceramic-shaped UI.
  const lines = allLines.filter((l): l is Extract<CartLine, { kind: 'ceramic' }> => l.kind === 'ceramic');
  const n = lines.length;
  const ship: ShipId = shipChoice;
  const currency = useCurrency();
  // Stripe only charges pln/eur/gbp; toChargeableCurrency maps any other
  // display currency to EUR.
  const chargeCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(currency);
  const priceOfLine = (l: Extract<CartLine, { kind: 'ceramic' }>) => priceOfCurrency(l.product, currency);
  const destination =
    destinations.find((d) => d.country === deliveryCountry) ??
    destinations.find((d) => d.country === defaultCountry) ??
    destinations[0];
  const shippingOf = (method: ShipId) => shippingOfCurrency(currency, method, destination.rates);
  const subtotal = lines.reduce((s, l) => s + priceOfLine(l), 0);
  // `destination.rates` is the same published table checkout resolves for
  // this country via getShippingRatesForCheckout, so what's shown here always
  // matches what the buyer is charged.
  const shipCost = shippingOf(ship);
  // Server preview is in minor units; the cart's own math is in major units.
  const promoDiscount = promo ? promo.discount / 100 : 0;
  const total = subtotal + shipCost - promoDiscount;
  const cardSplit = giftCard?.currency === chargeCurrency && total > 0
    ? splitGiftCardPayment(Math.round(total * 100), giftCard.available, STRIPE_MINIMUM_MINOR[chargeCurrency]) : null;
  // The figures the order summary renders. Before the PaymentIntent exists
  // this is the live estimate above — a legitimate pre-payment quote that must
  // keep tracking the buyer's delivery/promo/currency choices. After it
  // exists, the server's confirmed amounts win outright: the charge is locked,
  // so the display has to be too (same reasoning as the frozen promo row
  // below). A missing/malformed `amounts` payload parses to null and simply
  // leaves the estimate in place — never a blank or garbled price.
  const summary = cartSummaryAmounts(
    { currency, subtotal, shipping: shipCost, discount: promoDiscount, total },
    clientSecret ? confirmedAmounts : null,
  );
  const { fmt: sumFmt } = currencyFormatter(summary.currency);
  // GiftCardPayment formats server-confirmed minor amounts — including the
  // cash remainder Stripe will actually take. Once those exist it has to use
  // the CHARGED currency, not the live switcher's: the header switcher stays
  // usable behind the mounted payment form, and relabelling the cash-due
  // figure is the same desync the summary rows above are protected against.
  // Before confirmation there is nothing charged yet, so the live currency is
  // correct (and is what `giftCard.currency` is matched against).
  const giftCardCurrency = summary.confirmed ? summary.currency : chargeCurrency;
  const cartKey = lines.map((l) => l.id).join('|');

  // The cart changing (add/remove) — or the applied promo code changing — means
  // this is a different purchase intent than whatever was persisted: the Stripe
  // idempotency key is amount-sensitive and the redemption claim is
  // promo-bound, so both are part of the attempt identity (hard Phase 3 gate,
  // see attemptIdentityKey). Regenerate so a stale attemptId is never reused.
  // Skips the initial mount (same attempt).
  const attemptKey = attemptIdentityKey(cartKey, promo?.code ?? null) + (giftCard ? `\ncard:${giftCard.code}:${chargeCurrency}:${ship}` : '');
  const attemptCartKey = useRef(attemptKey);
  useEffect(() => {
    if (attemptCartKey.current === attemptKey) return;
    attemptCartKey.current = attemptKey;
    const id = crypto.randomUUID();
    localStorage.setItem(ATTEMPT_ID_KEY, id);
    setAttemptId(id);
  }, [attemptKey]);

  // Keep an applied promo honest when its inputs change: the previewed discount
  // was computed for a specific cart + currency, so a line add/remove or a
  // currency switch re-validates it (and an emptied cart just drops it). On a
  // network failure the code is kept — checkout remains the authority.
  const promoSyncKey = `${cartKey}|${chargeCurrency}`;
  const promoSyncRef = useRef(promoSyncKey);
  useEffect(() => {
    if (promoSyncRef.current === promoSyncKey) return;
    promoSyncRef.current = promoSyncKey;
    if (!promo) return;
    // /api/promo/validate resolves ids itself server-side — no need to
    // re-resolve cart lines here, just forward the raw (non-gift-card) ids.
    const current = useCart.getState().ids.filter((id) => !isGiftCardToken(id));
    // An emptied cart renders no promo UI at all; the next cart change lands
    // back here and re-validates, so no synchronous state write is needed.
    if (current.length === 0) return;
    let cancelled = false;
    fetch('/api/promo/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: promo.code, ids: current, locale }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok: boolean; code?: string; discount?: number; reason?: string } | null) => {
        if (cancelled || !data) return;
        if (data.ok && typeof data.discount === 'number') {
          setPromo({ code: data.code ?? promo.code, discount: data.discount });
        } else if (!data.ok) {
          setPromo(null);
          setPromoError(data.reason ?? 'not_found');
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoSyncKey]);

  async function applyPromo() {
    const raw = promoInput.trim();
    if (!raw || promoBusy) return;
    setPromoBusy(true);
    setPromoError(null);
    // Every apply-attempt outcome fires promo_apply — attempts are legitimately
    // repeatable, so unlike checkout_error this needs no dedup. `result` is the
    // GA4-facing outcome; `code` is the raw (unnormalized) input the buyer typed.
    const track = 'ceramics';
    const fireApplyEvent = (result: string) =>
      pushDataLayer(buildEngagementEvent('promo_apply', { result, code: raw, track }));
    try {
      const res = await fetch('/api/promo/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: raw, ids: lines.map((l) => l.id), locale }),
      });
      if (!res.ok) {
        // 400 (malformed) is indistinguishable from an unknown code for the
        // buyer; 429/5xx are retryable transport problems.
        if (res.status === 400) {
          setPromoError('not_found');
          fireApplyEvent('not_found');
        } else {
          setPromoError('network');
          fireApplyEvent('network_error');
        }
        return;
      }
      const data = (await res.json()) as
        | { ok: true; code: string; discount: number }
        | { ok: false; reason: string };
      if (data.ok) {
        setPromo({ code: data.code, discount: data.discount });
        setPromoInput('');
        fireApplyEvent('valid');
      } else {
        setPromoError(data.reason);
        fireApplyEvent(data.reason);
      }
    } catch {
      setPromoError('network');
      fireApplyEvent('network_error');
    } finally {
      setPromoBusy(false);
    }
  }

  function removePromo() {
    setPromo(null);
    setPromoError(null);
  }

  /** Maps a validate/checkout promo failure reason to its cart.promo.* copy. */
  const promoErrorKey = (reason: string) => {
    const key =
      reason === 'expired' ? 'expired'
      : reason === 'not_started' ? 'notStarted'
      : reason === 'wrong_track' ? 'wrongTrackCeramics'
      : reason === 'exhausted' ? 'exhausted'
      : reason === 'network' ? 'networkError'
      : 'invalid'; // not_found, inactive, anything unrecognised
    return `cart.promo.${key}` as Parameters<typeof t>[0];
  };

  useEffect(() => {
    if (lines.length === 0 || viewedCartKeys.current.has(cartKey)) return;
    viewedCartKeys.current.add(cartKey);
    const items = analyticsItemsForIds(
      lines.map((l) => l.id),
      lines.map(priceOfLine),
    );
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

  function handlePickCountry(country: DestinationCountry) {
    // Locked while a checkout POST is in flight: its answer is for the
    // country it was sent with.
    if (submitting || country === destination.country) return;
    setDeliveryCountry(country);
    // A point belongs to one country (and the price to its zone): pick again.
    setLocker(null);
    setServicePoint(null);
    setLockerMapOpen(false);
    try {
      localStorage.setItem(COUNTRY_KEY, country);
    } catch {
      // Private mode / blocked storage: the choice just is not remembered.
    }
  }

  // Client-side gate: the InPost shipment needs the right fields per method.
  const contactReady =
    contact.firstName.trim() !== '' &&
    contact.lastName.trim() !== '' &&
    EMAIL_RE.test(contact.email.trim());
  const phoneReady = ship === 'odbior' || contact.phone.trim() !== '';
  const lockerReady =
    ship !== 'paczkomat' ||
    (destination.channel === 'sendcloud'
      ? servicePoint !== null && servicePoint.country === destination.country
      : locker !== null);
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
      ...(ship !== 'odbior' ? { delivery_country: destination.country } : {}),
      ...(ship === 'paczkomat' && destination.channel === 'inpost_shipx' && locker ? { target_point: locker.name } : {}),
      ...(ship === 'paczkomat' && destination.channel === 'sendcloud' && servicePoint
        ? { service_point_id: String(servicePoint.id) }
        : {}),
      ...(ship === 'kurier'
        ? {
            address: {
              street: address.street.trim(),
              building_number: address.building.trim(),
              city: address.city.trim(),
              post_code: address.postCode.trim(),
              // InPost kurier is domestic only.
              country_code: 'PL',
            },
          }
        : {}),
    };
  }

  async function handleCheckout() {
    if (giftCard && giftCard.currency !== chargeCurrency) {
      setCheckoutError(t('giftBalance.wrongCurrency', { currency: giftCard.currency.toUpperCase() }));
      return;
    }
    if (!privateSale && lines.some((line) => line.kind === 'ceramic') && !inventoryReady) {
      setCheckoutError(t('ceramics.availabilityError'));
      return;
    }
    // Guard against a double-click: a second in-flight /api/checkout would
    // 409 against this buyer's own fresh reservation and silently strip the
    // items from their cart.
    if (lines.length === 0 || submitting || !deliveryReady) return;
    setSubmitting(true);
    setCheckoutError(null);
    forgetRememberedCheckout();
    // Freeze the opt-in for this attemptId BEFORE any await (a retry replays
    // the stored order). Storage is read at send time, not from the last
    // render, so a second tab on the same attemptId sends the first tab's value.
    const optIn = readSentMarketingOptIn(OPT_IN_KEY, attemptId) ?? lockedOptIn ?? marketingOptIn;
    rememberSentMarketingOptIn(OPT_IN_KEY, attemptId, optIn);
    setSentOptIn({ attemptId, optIn });
    setMarketingOptIn(optIn);
    const emailNorm = contact.email.trim().toLowerCase();
    const em = emailNorm ? await sha256Hex(emailNorm) : undefined;
    // begin_checkout itemises the whole cart with server-equal prices.
    const checkoutItems = analyticsItemsForIds(
      lines.map((l) => l.id),
      lines.map(priceOfLine),
    );
    pushCheckoutStartedItemsOnce(attemptId, checkoutItems, {
      shippingCost: shipCost,
      shippingMethod: ship,
      userData: em ? { em } : undefined,
      currency: analyticsCurrency,
      // Preview figure — the server hasn't confirmed the discount yet at this point.
      coupon: promo?.code,
      discountMinor: promo?.discount,
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
        // Send every line id; the server (validateCart) resolves and prices them.
        body: JSON.stringify({ ids: lines.map((l) => l.id), attemptId, ...deliveryBody(), marketing_cookies: collectMarketingCookies(), ...(optIn ? { marketing_email_opt_in: true } : {}), ...(privateSale && saleToken ? { private_sale_token: saleToken } : {}), ...(promo ? { promo_code: promo.code } : {}), ...(giftCard ? { gift_card_code: giftCard.code } : {}) }),
      });
      gotResponse = true;
      resOk = res.ok;
      resStatus = res.status;
      if (res.status === 409) {
        const conflict = (await res.json()) as { error?: string; sold?: string[] };
        if (conflict.error?.startsWith('gift_card_') || conflict.error === 'order_attempt_conflict' || conflict.error === 'ceramic_unavailable') {
          setCheckoutError(t(conflict.error === 'ceramic_unavailable' ? 'ceramics.cartBlocked' : 'giftBalance.invalid'));
          return;
        }
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
        if (conflict.error === 'promo_exhausted') {
          // The code's capacity ran out (or the claim raced away) — drop the
          // code, keep the rest of the form. Removing it changes the attempt
          // identity, so the next click starts a fresh attemptId (the server
          // marked this attempt's order failed during rollback).
          removePromo();
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'promo_exhausted', status: 409 }));
          setCheckoutError(t('cart.promo.exhausted'));
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
        let body400: { error?: string; reason?: string } | null = null;
        if (res.status === 400) {
          try {
            body400 = (await res.json()) as { error?: string; reason?: string };
          } catch {
            // Unparseable body — keep generic copy.
          }
        }
        if (body400?.error === 'invalid_delivery_point') {
          // Sendcloud did not confirm the point (gone, unavailable, other
          // country) — refused before anything was reserved or sent to
          // Stripe, gift card or not. Drop it so the buyer picks again, and
          // KEEP the attemptId: if an earlier POST of this attempt succeeded
          // with a lost response, its pending order still holds the pieces,
          // and only the same attemptId replays onto that hold (taking the
          // new point) instead of 409-ing against it until the TTL runs out.
          setServicePoint(null);
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: 'invalid_delivery_point', status: 400 }));
          setCheckoutError(t('cart.checkoutError'));
          return;
        }
        if (giftCard) { setCheckoutError(t('giftBalance.unavailable')); return; }
        // Abandon the attemptId: Stripe may have cached this failure under its
        // idempotency key, and the server already released any hold it took —
        // a fresh attempt is the only path that can succeed.
        resetAttemptId();
        let reason = 'checkout_failed';
        let errorMessage = t('cart.checkoutError');
        if (body400?.error === 'invalid_promo') {
          // The code stopped validating between apply and pay (operator
          // deactivation, expiry). Fail closed server-side surfaces here:
          // drop the code, keep the form.
          removePromo();
          reason = 'invalid_promo';
          errorMessage = t(promoErrorKey(body400.reason ?? 'not_found'));
        }
        pushDataLayer(buildEngagementEvent('checkout_error', { reason, status: res.status }));
        setCheckoutError(errorMessage);
        return;
      }
      const response = (await res.json()) as { status?: string; confirmation_url?: string; client_secret?: string; discount?: number; gift_card_amount?: number; cash_amount?: number; amounts?: unknown };
      if (response.status === 'paid' && response.confirmation_url) {
        const confirmation = new URL(response.confirmation_url, window.location.origin);
        if (confirmation.origin !== window.location.origin) throw new Error('Invalid confirmation URL');
        lines.forEach(line => remove(line.id));
        resetAttemptId();
        window.location.assign(confirmation.href);
        return;
      }
      const { client_secret, discount } = response;
      if (!client_secret) throw new Error('Missing payment response');
      // Reject a present-but-unparseable `amounts` the same way a missing
      // client_secret is rejected above — before anything below mounts the
      // payment form on pricing data that can't be trusted. An entirely
      // absent `amounts` (older deployment) is not an error; see
      // resolveConfirmedAmounts.
      const resolvedAmounts = resolveConfirmedAmounts(response.amounts);
      if (!resolvedAmounts.ok) throw new Error('Malformed payment amounts');
      if (typeof response.gift_card_amount === 'number' && typeof response.cash_amount === 'number') {
        setBalancePayment({ giftCard: response.gift_card_amount, cash: response.cash_amount });
      }
      // Re-sync the preview with the authoritative figure (shipping-aware
      // Stripe-minimum clamp can grant slightly more than the preview showed).
      if (promo && typeof discount === 'number') {
        setPromo({ code: promo.code, discount });
      }
      // Snapshot EVERY line id (+ price) so /koszyk/return fires a complete purchase
      // event (and never false-alarms a "purchase gap").
      rememberCheckoutForReturn(lines.map((l) => l.id), {
        // Deliberately the client-side estimate, not the server's confirmed
        // shipping: GA4 needs PER-ITEM prices, which only exist client-side,
        // so an event mixing server shipping with client item prices would not
        // reconcile. The snapshot stays internally consistent; the display
        // (which has no such constraint) uses the confirmed figures.
        shippingCost: shipCost,
        shippingMethod: ship,
        currency: analyticsCurrency,
        itemPrices: lines.map(priceOfLine),
        userData: em ? { em } : undefined,
        // Server-confirmed figure (just parsed above) — falls back to the
        // preview when the response carried no promo (no code applied).
        coupon: promo?.code,
        discountMinor: typeof discount === 'number' ? discount : promo?.discount,
      });
      // A later, separate purchase must never reuse this attemptId.
      if (!giftCard) resetAttemptId();
      // Kept adjacent to (and ahead of) setClientSecret: `clientSecret` is what
      // switches the summary over to these figures, and the two must land in
      // the same render. React batches both here; the ordering keeps that true
      // if this ever moves out of an event handler.
      setConfirmedAmounts(resolvedAmounts.amounts);
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
      if (!giftCard && gotResponse && !resOk && !shouldKeepAttemptIdOnCatch(resStatus)) resetAttemptId();
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

  // ── Cart-lines DTO still resolving ─────────────────────────────────────────
  // Only reachable when `ids` is non-empty (useCartLines resolves synchronously
  // to 'ready' for an empty cart), so this never masks a genuinely empty cart.
  if (linesStatus === 'loading') {
    return <div className="cart-empty" aria-busy="true" />;
  }

  // ── Cart-lines DTO fetch failed ──────────────────────────────────────────
  // Distinct from the empty state so a transient network failure never reads
  // to the buyer as "your cart was cleared".
  if (linesStatus === 'error') {
    return (
      <div className="cart-empty">
        <h2>{t('cart.loadError')}</h2>
      </div>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (n === 0) {
    return (
      <div className="cart-empty">
        {showUnavailableNotice && <p className="cart-notice">{t('cart.unavailableRemoved')}</p>}
        <h2>{t.rich('cart.emptyH', richTags)}</h2>
        <p>{t('cart.emptyP')}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {SEE_KEYS.filter(({ href }) => !isCategoryHidden(href.slice(1) as CategorySlug)).map(({ key, href, primary }) => (
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

  // Country names in the page language; the select lists them alphabetically.
  const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type: 'region' }) : null;
  const regionName = (code: string) => regionNames?.of(code) ?? code;
  const destinationsByName = [...destinations].sort((a, b) =>
    regionName(a.country).localeCompare(regionName(b.country), locale),
  );

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
        {showUnavailableNotice && <p className="cart-notice">{t('cart.unavailableRemoved')}</p>}
        <div className="cart-list">
          {lines.map((l) => {
            const p = l.product;
            const cat = CATEGORIES[p.category];
            const name = t(`product.${cat.singularKey}` as Parameters<typeof t>[0]);
            const lineDisplayName = productDisplayName(p, name);
            return (
              <div key={l.id} className="cart-row" data-testid="cart-line" data-product-id={p.id}>
                <Link href={`/${p.category}/${p.id}`} className="thumb" aria-label={lineDisplayName}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} srcSet={srcSet(p.image)} sizes="(min-width:561px) 96px, 72px" alt="" />
                </Link>
                <div>
                  <h4>{lineDisplayName}</h4>
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
                          itemPrices: [priceOfLine(l)],
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
            {destinations.length > 1 && (
              <label className="field cart-country">
                <span>{t('delivery.country')}</span>
                <select
                  value={destination.country}
                  onChange={(e) => handlePickCountry(e.target.value as DestinationCountry)}
                  autoComplete="country"
                  data-testid="delivery-country"
                  disabled={submitting}
                >
                  {destinationsByName.map((d) => (
                    <option key={d.country} value={d.country}>
                      {regionName(d.country)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="ship-opts" role="radiogroup" aria-label={t('cart.delivery')}>
              <ShipOption
                id="paczkomat"
                active={ship === 'paczkomat'}
                onPick={handlePickShip}
                title={t('ship.paczkomatT')}
                desc={t('ship.paczkomatD')}
                price={priceLabel('paczkomat')}
              />
              {COURIER_ENABLED && (
                <ShipOption
                  id="kurier"
                  active={ship === 'kurier'}
                  onPick={handlePickShip}
                  title={t('ship.courierT')}
                  desc={t('ship.courierD')}
                  price={priceLabel('kurier')}
                />
              )}
              {STUDIO_PICKUP_ENABLED && (
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
            <div className="delivery-fields">
              {/* Only while Poland is the one destination checkout offers. */}
              {destinations.length === 1 && destination.country === 'PL' && (
                <p className="cart-pl-only" data-testid="pl-only-note">{t('delivery.plOnly')}</p>
              )}
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
              <MarketingOptInCheckbox checked={lockedOptIn ?? marketingOptIn} onChange={setMarketingOptIn} disabled={submitting || lockedOptIn !== null} />
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

              {ship === 'paczkomat' && destination.channel === 'sendcloud' && (
                <div className="locker-pick">
                  {servicePoint && (
                    <p className="locker-chosen" data-testid="selected-locker">
                      {t('delivery.lockerChosen')} <strong>{servicePoint.name}</strong>
                      {servicePoint.street && (
                        <>
                          {' — '}
                          {[`${servicePoint.street} ${servicePoint.houseNumber}`.trim(), `${servicePoint.postalCode} ${servicePoint.city}`.trim()]
                            .filter(Boolean)
                            .join(', ')}
                        </>
                      )}
                    </p>
                  )}
                  <SendcloudPointPicker
                    key={destination.country}
                    country={destination.country}
                    carrier={destination.carrier}
                    language={locale}
                    chosen={servicePoint !== null}
                    disabled={submitting}
                    onSelect={(p) => {
                      pushDataLayer(
                        buildEngagementEvent('parcel_locker_point_selected', { locker_name: p.code || p.name }),
                      );
                      setServicePoint(p);
                    }}
                    chooseLabel={t('delivery.chooseLocker')}
                    changeLabel={t('delivery.changeLocker')}
                    unavailableLabel={t('delivery.lockerUnavailable')}
                  />
                </div>
              )}

              {ship === 'paczkomat' && destination.channel === 'inpost_shipx' && (
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
          </div>
        )}

        <div className="cart-cta">
          {!clientSecret && (
            <div className="cart-cta-total">
              <span className="k">{t('cart.total')}</span>
              {/* !clientSecret here, so `summary` is the estimate by
                  definition — routed through it anyway so every rendered
                  total in this component has exactly one source. */}
              <span className="v">{sumFmt(summary.total)}</span>
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
              type="button"
              onClick={() => void handleCheckout()}
              disabled={submitting || !deliveryReady}
            >
              {t(cardSplit?.cash === 0 ? 'giftBalance.placeOrder' : 'cart.checkout')} <Icon name="arrow" />
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
            const p = l.product;
            const cat = CATEGORIES[p.category];
            const name = t(`product.${cat.singularKey}` as Parameters<typeof t>[0]);
            const lineDisplayName = productDisplayName(p, name);
            return (
              <li key={l.id} className="sum-item">
                <Link href={`/${p.category}/${p.id}`} className="sum-item-thumb" aria-label={lineDisplayName}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} srcSet={srcSet(p.image)} sizes="56px" alt="" />
                </Link>
                <div className="sum-item-info">
                  <span className="sum-item-name">{lineDisplayName}</span>
                  <span className="sum-item-price">{fmt(priceOfLine(l))}</span>
                </div>
              </li>
            );
          })}
        </ul>
        {/* All four summary figures come from one snapshot (`summary`) so the
            rows always add up: swapping only shipping/total for the server's
            numbers while items stayed client-priced would show a subtotal that
            no longer reconciles with the total below it. */}
        <div className="sum-row">
          <span className="k">{t('cart.pieces')} ({n})</span>
          <span className="v" data-testid="summary-subtotal">{sumFmt(summary.subtotal)}</span>
        </div>
        <div className="sum-row">
          <span className="k">{t('cart.delivery')}</span>
          <span className="v" data-testid="summary-shipping">{summary.shipping > 0 ? sumFmt(summary.shipping) : t('cart.free')}</span>
        </div>
        {promo ? (
          <div className="sum-row promo-row" data-testid="promo-discount-row">
            <span className="k">
              {t('cart.promo.discountRow', { code: promo.code })}
              {/* Once the PaymentIntent exists (clientSecret), its amount is
                  locked — changing the code here could only desync the display
                  from what Stripe will charge. */}
              {!clientSecret && (
                <button
                  type="button"
                  className="promo-remove"
                  data-testid="promo-remove"
                  onClick={removePromo}
                >
                  {t('cart.promo.remove')}
                </button>
              )}
            </span>
            <span className="v" data-testid="summary-discount">-{sumFmt(summary.discount)}</span>
          </div>
        ) : clientSecret || giftCard ? null : (
          <div className="promo-entry">
            {promoOpen ? (
              <div className="promo-form">
                <input
                  data-testid="promo-input"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  placeholder={t('cart.promo.placeholder')}
                  aria-label={t('cart.promo.label')}
                  aria-describedby={promoError ? 'promo-error' : undefined}
                  aria-invalid={promoError ? true : undefined}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void applyPromo();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost promo-apply"
                  data-testid="promo-apply"
                  disabled={promoBusy || promoInput.trim() === ''}
                  onClick={() => void applyPromo()}
                >
                  {t('cart.promo.apply')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="promo-toggle"
                data-testid="promo-toggle"
                onClick={() => setPromoOpen(true)}
              >
                {t('cart.promo.have')}
              </button>
            )}
            {promoError && (
              <p className="promo-error" id="promo-error" role="alert" data-testid="promo-error">
                {t(promoErrorKey(promoError))}
              </p>
            )}
          </div>
        )}
        <div className="sum-total">
          <span className="k">{t('cart.total')}</span>
          <span className="v" data-testid="summary-total">{sumFmt(summary.total)}</span>
        </div>
        {!promo && <GiftCardPayment key={giftCardCurrency} card={giftCard} onChange={setGiftCard}
          total={Math.round(total * 100)} currency={giftCardCurrency} locked={submitting || !!clientSecret} confirmed={balancePayment} />}
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
