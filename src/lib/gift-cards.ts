/**
 * Gift-card domain: fixed denomination tiers, cart-token encode/decode, and
 * price lookup. This is the shared contract between checkout/cart code and
 * the storefront PDP — keep the exported surface stable.
 *
 * Schema approach ("Option A", see docs/gift-cards.md): a paid gift-card
 * order does NOT create its own balance-ledger row here — it mints a
 * single-use, fixed-amount `promo_codes` row (see
 * supabase/migrations/20260904120000_gift_card_promo_codes.sql), reusing the
 * existing promo claim/settle RPCs. `buildGiftCardPromoRow` is the pure
 * builder for that row; the webhook route performs the actual insert.
 *
 * Gift cards are their own exclusive cart/order track (like ceramics vs.
 * prints today): no shipping, no piece reservation, cannot mix with ceramics
 * or prints in the same order — enforced in `src/lib/checkout.ts`.
 */
import type { Currency } from './currency';
import { toMinor } from './pricing';

// ── Tiers ────────────────────────────────────────────────────────────────

export type GiftCardTierId = 'gc-200' | 'gc-500' | 'gc-1000' | 'gc-2000';

export interface GiftCardTier {
  /** Stable id — used in cart tokens, order_items.variant, and minted promo_codes.campaign. Never renumber. */
  id: GiftCardTierId;
  /** Major-unit face value per currency (PLN/EUR/GBP) — a gift card has an explicit, stable value in every checkout currency (no live FX conversion). */
  amountPln: number;
  amountEur: number;
  amountGbp: number;
}

/**
 * The 4 fixed denominations. No custom amount is offered.
 * PLN is the canonical figure; EUR/GBP are the settled round-number
 * equivalents (see AGENTS.md decisions for this feature).
 */
export const GIFT_CARD_TIERS: readonly GiftCardTier[] = [
  { id: 'gc-200', amountPln: 200, amountEur: 50, amountGbp: 40 },
  { id: 'gc-500', amountPln: 500, amountEur: 120, amountGbp: 100 },
  { id: 'gc-1000', amountPln: 1000, amountEur: 250, amountGbp: 200 },
  { id: 'gc-2000', amountPln: 2000, amountEur: 500, amountGbp: 400 },
];

const TIERS_BY_ID: ReadonlyMap<GiftCardTierId, GiftCardTier> = new Map(
  GIFT_CARD_TIERS.map((t) => [t.id, t]),
);

export function isGiftCardTierId(id: string): id is GiftCardTierId {
  return TIERS_BY_ID.has(id as GiftCardTierId);
}

/** Look up a tier by id. Returns null for an unknown/malformed id. */
export function getGiftCardTier(id: string): GiftCardTier | null {
  return TIERS_BY_ID.get(id as GiftCardTierId) ?? null;
}

/** Major-unit face value of a tier in a given checkout/display currency. */
export function giftCardAmountMajor(tier: GiftCardTier, currency: Currency): number {
  switch (currency) {
    case 'pln':
      return tier.amountPln;
    case 'gbp':
      return tier.amountGbp;
    case 'eur':
    default:
      return tier.amountEur;
  }
}

const CURRENCY_SUFFIX: Record<'pln' | 'eur' | 'gbp', string> = { pln: 'zł', eur: '€', gbp: '£' };

/** Human-readable "500 zł" / "120 €" label for a tier in a currency (emails, invoices, admin). */
export function formatGiftCardAmount(tier: GiftCardTier, currency: 'pln' | 'eur' | 'gbp'): string {
  return `${giftCardAmountMajor(tier, currency)} ${CURRENCY_SUFFIX[currency]}`;
}

// ── Cart token ───────────────────────────────────────────────────────────
// Mirrors print-cart.ts's `print:<...>` token pattern: `giftcard:<tierId>`.

const TOKEN_PREFIX = 'giftcard';

/** True when a cart id is a gift-card token (vs. a ceramic id or a print token). */
export function isGiftCardToken(id: string): boolean {
  return id.startsWith(`${TOKEN_PREFIX}:`);
}

export function encodeGiftCardToken(tierId: GiftCardTierId): string {
  return `${TOKEN_PREFIX}:${tierId}`;
}

/** Decode and validate a cart token. Returns null for any malformed token or unknown tier. */
export function decodeGiftCardToken(token: string): { tierId: GiftCardTierId } | null {
  if (!isGiftCardToken(token)) return null;
  const parts = token.split(':');
  if (parts.length !== 2) return null;
  const [, rawTierId] = parts;
  if (!rawTierId || !isGiftCardTierId(rawTierId)) return null;
  return { tierId: rawTierId };
}

// ── Resolve to a checkout/display line ──────────────────────────────────

export interface GiftCardLine {
  tierId: GiftCardTierId;
  tier: GiftCardTier;
  /** Minor-unit price in the given currency — checkout's unit_price. */
  unitPriceMinor: number;
}

/**
 * Resolve a cart token to a priced line in the given currency. Returns null
 * for a malformed or unknown-tier token — callers drop it (client-side cart
 * resolution) or reject the whole cart (checkout's validateCart).
 */
export function resolveGiftCardToken(
  token: string,
  currency: 'pln' | 'eur' | 'gbp',
): GiftCardLine | null {
  const dec = decodeGiftCardToken(token);
  if (!dec) return null;
  const tier = getGiftCardTier(dec.tierId);
  if (!tier) return null;
  return {
    tierId: dec.tierId,
    tier,
    unitPriceMinor: toMinor(giftCardAmountMajor(tier, currency)),
  };
}

// ── Order-item variant snapshot ─────────────────────────────────────────
// Stored in order_items.variant (jsonb) alongside the existing print shape
// (`{ kind: 'print', ... }`) — NULL still means "ceramic". Consumers that key
// off order_items.variant (invoice.ts, the Stripe webhook route) must check
// `.kind` rather than assuming non-null implies "print".

export interface GiftCardOrderItemVariant {
  kind: 'giftcard';
  tierId: GiftCardTierId;
}

export function isGiftCardOrderItemVariant(
  variant: unknown,
): variant is GiftCardOrderItemVariant {
  return (
    typeof variant === 'object' &&
    variant !== null &&
    (variant as { kind?: unknown }).kind === 'giftcard' &&
    isGiftCardTierId(String((variant as { tierId?: unknown }).tierId ?? ''))
  );
}

// ── Buyer contact (no delivery form — the buyer always receives the code) ──

export interface GiftCardContact {
  first_name: string;
  last_name: string;
  email: string;
  /** Optional — gift-card orders have no shipment, so a phone number is never required. */
  phone: string | null;
}

export type ValidateGiftCardContactResult =
  | { ok: true; contact: GiftCardContact }
  | { ok: false; reason: 'invalid_contact' };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// Minimal shape check — same pattern as src/lib/newsletter.ts's EMAIL_RE.
// Not full RFC 5322 validation; just enough to catch an unparseable address
// before checkout succeeds and the promo-code send has nowhere to go.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the buyer contact for a gift-card checkout: name + email only —
 * deliberately no address/phone requirement (decision: the buyer always
 * receives the code themselves, no recipient/gifting form).
 */
export function validateGiftCardContact(raw: unknown): ValidateGiftCardContactResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid_contact' };
  const body = raw as Record<string, unknown>;
  const c = (body.contact ?? {}) as Record<string, unknown>;
  const first_name = str(c.first_name);
  const last_name = str(c.last_name);
  const email = str(c.email);
  const phone = str(c.phone);
  if (!first_name || !last_name || !email) return { ok: false, reason: 'invalid_contact' };
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_contact' };
  return { ok: true, contact: { first_name, last_name, email, phone } };
}

// ── Minting a redemption code (Option A) ────────────────────────────────
// Pure builder for the promo_codes insert payload. The actual DB write
// (+ idempotency via the unique index on source_order_id) lives in the
// Stripe webhook route, which is the only caller with a Supabase client.

export interface MintedGiftCardPromoRow {
  code: string;
  kind: 'fixed';
  percent: null;
  amount_pln: number; // minor units
  amount_eur: number;
  amount_gbp: number;
  applies_to: 'all';
  active: true;
  starts_at: null;
  expires_at: null;
  /** Single-use: the code is meant for exactly one future order. */
  max_redemptions: 1;
  newsletter_welcome: false;
  campaign: string;
  source: 'gift_card';
  source_order_id: string;
  created_by: string;
  updated_by: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easier to read/type off a printed card

/**
 * Generate a random gift-card code, e.g. `GIFT-7K3P9QRT`. `randomBytes`
 * defaults to `crypto.getRandomValues` (available in both Workers and Node
 * test runs); injectable for deterministic tests.
 */
export function generateGiftCardCode(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < bytes.length; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `GIFT-${suffix}`;
}

/**
 * Build the `promo_codes` insert payload for a paid gift-card order. Pure —
 * no I/O, no randomness unless `code` is omitted (then `generateGiftCardCode`
 * mints one). `campaign` carries the tier id for operator legibility in the
 * admin promotions table (source is the real discriminator — see
 * src/lib/admin/promotions.ts).
 */
export function buildGiftCardPromoRow(params: {
  tier: GiftCardTier;
  orderId: string;
  code?: string;
}): MintedGiftCardPromoRow {
  const code = params.code ?? generateGiftCardCode();
  return {
    code,
    kind: 'fixed',
    percent: null,
    amount_pln: toMinor(params.tier.amountPln),
    amount_eur: toMinor(params.tier.amountEur),
    amount_gbp: toMinor(params.tier.amountGbp),
    applies_to: 'all',
    active: true,
    starts_at: null,
    expires_at: null,
    max_redemptions: 1,
    newsletter_welcome: false,
    campaign: `gift-card:${params.tier.id}`,
    source: 'gift_card',
    source_order_id: params.orderId,
    created_by: 'system:gift-card',
    updated_by: 'system:gift-card',
  };
}
