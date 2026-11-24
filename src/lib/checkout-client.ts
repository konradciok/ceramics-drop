import { SELLABLE_CURRENCIES, type Currency } from './currency';

/**
 * The amounts POST /api/checkout actually priced the order from — minor units,
 * in the currency it charged. Returned under `amounts` on every success
 * response (see src/app/api/checkout/route.ts).
 *
 * Why this exists: the cart's own summary is computed from the CODE-default
 * rate tables, while checkout prices the charge from the CMS-published bundle
 * (`getShippingRatesForCheckout()`). A publish between page load and payment
 * moves one and not the other, so once the PaymentIntent exists the cart must
 * stop showing its own estimate and show these instead — the same principle
 * that already freezes the promo row once `clientSecret` is set.
 *
 * `currency` travels with the numbers deliberately: the buyer can still flip
 * the header currency switcher while the Stripe form is mounted, and a minor
 * amount rendered under the wrong symbol would be its own desync.
 */
export type CheckoutAmounts = {
  currency: Currency;
  /** Merchandise, pre-discount. */
  subtotal: number;
  shipping: number;
  discount: number;
  /**
   * The ORDER total: subtotal − discount + shipping. It is what the buyer
   * owes, which is what a cart summary renders — but it is NOT always what
   * Stripe charges. On a gift-card-funded order the PaymentIntent is created
   * for the cash remainder alone (`ensureBalanceIntent`,
   * src/server/gift-card-checkout.ts), with the card balance covering the
   * rest, so never label this figure "you will be charged X". That split
   * arrives on the same response as `cash_amount` / `gift_card_amount`, and
   * GiftCardPayment renders it.
   */
  total: number;
};

const AMOUNT_KEYS = ['subtotal', 'shipping', 'discount', 'total'] as const;

const isMinorAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Narrows an untrusted `amounts` payload. Returns null on anything malformed
 * or missing — this function alone cannot tell "the field was never sent" (an
 * older deployment) apart from "the field was sent and is garbage" (a broken
 * response on a live deployment), which matter very differently to a caller:
 * the former is fine to fall back from, the latter is not. See
 * `resolveConfirmedAmounts`, which makes that distinction.
 */
export function parseCheckoutAmounts(value: unknown): CheckoutAmounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!(SELLABLE_CURRENCIES as readonly string[]).includes(raw.currency as string)) return null;
  if (!AMOUNT_KEYS.every((key) => isMinorAmount(raw[key]))) return null;
  const subtotal = raw.subtotal as number;
  const shipping = raw.shipping as number;
  const discount = raw.discount as number;
  const total = raw.total as number;
  // Individually valid fields can still be mutually incoherent (e.g. a
  // truncated/tampered/buggy payload) — reject rather than render order rows
  // that don't add up in front of the buyer.
  const expectedTotal = subtotal - discount + shipping;
  if (discount > subtotal || !Number.isSafeInteger(expectedTotal) || total !== expectedTotal) {
    return null;
  }
  return {
    currency: raw.currency as Currency,
    subtotal,
    shipping,
    discount,
    total,
  };
}

/**
 * What a checkout response's `amounts` field (whatever it was, including
 * absent — pass `response.amounts`) means for the caller, told apart from
 * `parseCheckoutAmounts` alone.
 *
 * `{ ok: true, amounts: null }` — the field was never sent at all. This is a
 * client talking to an older deployment that predates it: a legitimate,
 * intentional backward-compat case, no worse off than before the field
 * existed. The caller keeps its own live estimate.
 *
 * `{ ok: false }` — the field WAS sent and failed to parse (garbled, or
 * arithmetically incoherent). On a live deployment this means the response
 * itself is broken. The caller must reject the whole response — falling back
 * to the mutable client estimate here would silently show the buyer a stale
 * total right next to a mounted Stripe payment form.
 *
 * `{ ok: true, amounts: CheckoutAmounts }` — parsed cleanly; these are what
 * Stripe will charge.
 */
export function resolveConfirmedAmounts(
  amounts: unknown,
): { ok: true; amounts: CheckoutAmounts | null } | { ok: false } {
  if (amounts === undefined) return { ok: true, amounts: null };
  const parsed = parseCheckoutAmounts(amounts);
  if (!parsed) return { ok: false };
  return { ok: true, amounts: parsed };
}

/** Cart-summary figures in MAJOR units, plus which side they came from. */
export type CartSummaryAmounts = {
  currency: Currency;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  /** True once these are the server's charged figures, not a live estimate. */
  confirmed: boolean;
};

/**
 * Picks what the cart summary renders. Before the PaymentIntent exists there
 * is nothing authoritative to show, so the live client estimate wins — it is a
 * legitimate pre-payment quote. Once the server has confirmed amounts, THOSE
 * win unconditionally: they are what Stripe will charge, so the display can no
 * longer drift away from them (currency switch, rate republish, anything).
 *
 * Callers pass `confirmed` as null until `clientSecret` is set.
 */
export function cartSummaryAmounts(
  estimate: {
    currency: Currency;
    /** MAJOR units, as the cart computes them. */
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
  },
  confirmed: CheckoutAmounts | null,
): CartSummaryAmounts {
  if (!confirmed) return { ...estimate, confirmed: false };
  return {
    currency: confirmed.currency,
    subtotal: confirmed.subtotal / 100,
    shipping: confirmed.shipping / 100,
    discount: confirmed.discount / 100,
    total: confirmed.total / 100,
    confirmed: true,
  };
}

/**
 * Identity of one checkout attempt: cart contents + the applied promo code.
 * CartView regenerates `attemptId` whenever this key changes. The promo code
 * MUST participate (hard Phase 3 gate): the Stripe idempotency key
 * `pi_create_<orderId>` is amount-sensitive, and `claim_promo_redemption`
 * rejects a reused order id that carries a different promo — a stale
 * attemptId across a code change would surface as a Stripe 400 or a
 * misleading `promo_exhausted`. The `\n` delimiter cannot appear in a cart
 * key (ids are registry ids / `giftcard:` tokens), so no (cartKey, promo) pair
 * can alias another.
 */
export function attemptIdentityKey(cartKey: string, promoCode: string | null): string {
  return promoCode ? `${cartKey}\npromo:${promoCode}` : cartKey;
}

/** HTTP statuses where checkout fails before reserve/PI — attemptId must survive retries. */
export const CHECKOUT_KEEP_ATTEMPT_STATUSES = new Set([409, 429, 503]);

export function shouldKeepAttemptIdOnCatch(status: number): boolean {
  return CHECKOUT_KEEP_ATTEMPT_STATUSES.has(status);
}

export type CheckoutPreBodyError = {
  errorKey: 'cart.serviceUnavailable' | 'cart.rateLimited';
  analyticsReason: 'service_unavailable' | 'rate_limited';
  analyticsStatus: 429 | 503;
};

/**
 * Maps 429/503 checkout responses where the server rejected before any
 * reserve/Stripe work. Caller keeps attemptId and shows the returned error key.
 */
export function checkoutPreBodyError(
  status: number,
  body?: { error?: string },
): CheckoutPreBodyError | null {
  if (status === 429) {
    return {
      errorKey: 'cart.rateLimited',
      analyticsReason: 'rate_limited',
      analyticsStatus: 429,
    };
  }
  if (status === 503) {
    // A coded 503 (e.g. gift_card_unavailable) has its own handling downstream;
    // a bare one is an edge/platform blip before any reserve/PI work.
    if (body?.error) return null;
    return {
      errorKey: 'cart.serviceUnavailable',
      analyticsReason: 'service_unavailable',
      analyticsStatus: 503,
    };
  }
  return null;
}

/**
 * The marketing-email opt-in is FROZEN per checkout attempt. A retry that
 * keeps its attemptId (lost response, 409 checkout_in_progress, 429/503)
 * replays the order the first POST stored — including its `marketing` value,
 * which neither the duplicate insert nor `prepare_balance_order` rewrites. If
 * the buyer could change the box between those requests, the stored choice
 * would silently differ from what the screen shows. So the value sent with an
 * attemptId is remembered (surviving a reload, like the attemptId itself) and
 * the checkbox is locked to it until the attemptId resets. Starting a fresh
 * attempt instead is not an option: the old attempt's piece hold would 409 it.
 */
type OptInStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * How long a sent choice stays frozen. Not a count cap — that could evict an
 * attempt another tab can still replay. 24 h outlives every replay path: the
 * pending order expires via the 15-min cron sweep, and Stripe idempotency keys
 * live 24 h; after that a retry is answered `order_conflict` and resets the id.
 */
export const OPT_IN_FREEZE_TTL_MS = 24 * 60 * 60 * 1000;

type OptInEntry = { optIn: boolean; at: number };

/** `{ [attemptId]: { optIn, at } }` minus expired/malformed entries. */
function readOptInMap(storage: OptInStorage, storageKey: string, now: number): Record<string, OptInEntry> {
  try {
    const raw = JSON.parse(storage.getItem(storageKey) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, OptInEntry] => {
        const v = entry[1] as Partial<OptInEntry> | null;
        return (
          !!v && typeof v.optIn === 'boolean' && typeof v.at === 'number' &&
          now - v.at < OPT_IN_FREEZE_TTL_MS
        );
      }),
    );
  } catch {
    return {};
  }
}

/**
 * The opt-in already sent with `attemptId`, or null when nothing was sent.
 * Choices are kept PER attempt (not just the latest): two tabs can hold
 * different attempts, and one moving on must not unlock the other's.
 */
export function readSentMarketingOptIn(
  storageKey: string,
  attemptId: string,
  storage: OptInStorage | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
  now: number = Date.now(),
): boolean | null {
  if (!storage || !attemptId) return null;
  return readOptInMap(storage, storageKey, now)[attemptId]?.optIn ?? null;
}

/** Record the opt-in sent with `attemptId`; expired entries are pruned on write. */
export function rememberSentMarketingOptIn(
  storageKey: string,
  attemptId: string,
  optIn: boolean,
  storage: OptInStorage | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
  now: number = Date.now(),
): void {
  if (!storage || !attemptId) return;
  const map = readOptInMap(storage, storageKey, now);
  // An attempt keeps its FIRST recorded time: re-sending must not extend it.
  map[attemptId] = { optIn, at: map[attemptId]?.at ?? now };
  try {
    storage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // Storage full/blocked: the in-memory freeze still holds for this page.
  }
}
