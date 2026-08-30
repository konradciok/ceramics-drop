/**
 * Promo-code domain logic: code normalization, eligibility rules, and the
 * server-side discount math. Pure apart from `fetchPromoByCode` (injected
 * Supabase client, house style — see private-sale.ts). The atomic redemption
 * lifecycle lives in the `claim_promo_redemption` / `settle_promo_redemption`
 * RPCs (migration 20260830120000_promo_codes.sql); this module never mutates.
 * Plan: docs/superpowers/plans/2026-08-30-promo-codes-master.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type PromoKind = 'percent' | 'fixed';
export type PromoAppliesTo = 'all' | 'ceramics' | 'prints';
/** Cart fulfilment type; carts are never mixed. */
export type PromoTrack = 'ceramics' | 'prints';

export interface PromoCode {
  id: string; // uuid
  code: string; // normalized (see normalizePromoCode)
  kind: PromoKind;
  percent: number | null; // 1..100 when kind='percent'
  amount_pln: number | null; // minor units when kind='fixed'
  amount_eur: number | null;
  amount_gbp: number | null;
  applies_to: PromoAppliesTo;
  active: boolean;
  starts_at: string | null; // ISO timestamps
  expires_at: string | null;
  max_redemptions: number | null;
  newsletter_welcome: boolean;
  campaign: string | null; // operator-facing label
}

const CODE_RE = /^[A-Z0-9_-]{3,32}$/;

/** Trim, uppercase, NFKC-normalize; null unless the result matches ^[A-Z0-9_-]{3,32}$. */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.normalize('NFKC').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export type PromoIneligibleReason =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'wrong_track'
  | 'exhausted';

export type PromoEligibility =
  | { ok: true; promo: PromoCode }
  | { ok: false; reason: PromoIneligibleReason };

/**
 * Pure eligibility check. `redemptionCount` is the live claim count
 * (pending + redeemed). The schedule window is [starts_at, expires_at):
 * valid strictly while now < expires_at.
 */
export function checkPromoEligibility(
  promo: PromoCode | null,
  track: PromoTrack,
  redemptionCount: number,
  now: Date = new Date(),
): PromoEligibility {
  if (!promo) return { ok: false, reason: 'not_found' };
  if (!promo.active) return { ok: false, reason: 'inactive' };
  if (promo.starts_at !== null && now < new Date(promo.starts_at)) {
    return { ok: false, reason: 'not_started' };
  }
  if (promo.expires_at !== null && now >= new Date(promo.expires_at)) {
    return { ok: false, reason: 'expired' };
  }
  if (promo.applies_to !== 'all' && promo.applies_to !== track) {
    return { ok: false, reason: 'wrong_track' };
  }
  if (promo.max_redemptions !== null && redemptionCount >= promo.max_redemptions) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, promo };
}

/** Stripe's minimum chargeable amount per currency, in minor units. */
export const STRIPE_MIN_MINOR: Record<'pln' | 'eur' | 'gbp', number> = {
  pln: 200,
  eur: 50,
  gbp: 30,
};

/**
 * Discount in minor units, applied to the merchandise subtotal only — never
 * shipping. Clamp 1: never exceeds the subtotal. Clamp 2 (Stripe minimum):
 * the max discount is the amount by which the undiscounted charge exceeds the
 * per-currency minimum, floored at 0 — so the charge lands exactly on the
 * minimum when the clamp bites. An undersized cart already below the minimum
 * keeps discount 0 (its chargeability is not the promo's problem); never
 * negative, never a rejection.
 */
export function computePromoDiscountMinor(
  promo: PromoCode,
  subtotalMinor: number,
  shippingMinor: number,
  currency: 'pln' | 'eur' | 'gbp',
): number {
  let discount = 0;
  if (promo.kind === 'percent') {
    discount = Math.floor((subtotalMinor * (promo.percent ?? 0)) / 100);
  } else {
    discount = promo[`amount_${currency}`] ?? 0;
  }
  discount = Math.min(discount, subtotalMinor);
  const maxBeforeStripeMin = Math.max(
    0,
    subtotalMinor + shippingMinor - STRIPE_MIN_MINOR[currency],
  );
  discount = Math.min(discount, maxBeforeStripeMin);
  return Math.max(0, discount);
}

/**
 * Look up a promo by (already normalized) code plus its live redemption count
 * (pending + redeemed — the number `max_redemptions` counts against). Query
 * errors degrade to `{ promo: null, redemptionCount: 0 }` / count 0 — safe
 * because capacity is enforced authoritatively by the atomic
 * `claim_promo_redemption` RPC at checkout, not by this read.
 */
/**
 * The single promo flagged for the newsletter welcome email (at most one can
 * be `newsletter_welcome AND active` — partial unique index). Storefront-side
 * (Phase 5 imports this from the confirm route); DB errors surface to the
 * caller, which treats the welcome email as best-effort.
 */
export async function getActiveNewsletterPromo(supabase: SupabaseClient): Promise<PromoCode | null> {
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('newsletter_welcome', true)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`newsletter promo lookup failed: ${error.message}`);
  return (data as PromoCode | null) ?? null;
}

export async function fetchPromoByCode(
  supabase: SupabaseClient,
  code: string,
): Promise<{ promo: PromoCode | null; redemptionCount: number }> {
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error || !data) return { promo: null, redemptionCount: 0 };
  const promo = data as PromoCode;
  const { count, error: countError } = await supabase
    .from('promo_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('promo_id', promo.id)
    .in('status', ['pending', 'redeemed']);
  if (countError) return { promo, redemptionCount: 0 };
  return { promo, redemptionCount: count ?? 0 };
}
