/* ============================================================
   Admin promotions repository — CRUD + utilization stats for `promo_codes`.
   Built on the /admin/pricing pattern: callers inject the service-role client
   (adminSupabase()), reads throw, mutations return { status, body } so the
   /api/admin/promotions* routes stay thin adapters, and every mutation writes
   a catalog_audit_log row keyed 'promo:<CODE>' (no FK on product_id — the
   sentinel is safe, same as 'print-pricing'). The `code` is IMMUTABLE after
   creation: order stats join on orders.promo_code and the audit key embeds it,
   so a rename would orphan both histories.
   ============================================================ */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePromoCode, type PromoCode } from '@/lib/promo';

export const promoInputSchema = z.object({
  code: z.string(),
  kind: z.enum(['percent', 'fixed']),
  percent: z.number().int().min(1).max(100).nullable(),
  amount_pln: z.number().int().positive().nullable(), // minor units (UI converts from major)
  amount_eur: z.number().int().positive().nullable(),
  amount_gbp: z.number().int().positive().nullable(),
  applies_to: z.enum(['all', 'ceramics', 'prints']),
  starts_at: z.string().datetime().nullable(), // UTC ISO — rejects raw datetime-local values
  expires_at: z.string().datetime().nullable(),
  max_redemptions: z.number().int().positive().nullable(),
  newsletter_welcome: z.boolean(),
  campaign: z.string().max(120).nullable(),
});
export type PromoInput = z.infer<typeof promoInputSchema>;

/** Fields the cross-field rules span — validated on CREATE input and on the MERGED record for PATCH. */
type CrossFieldRecord = Pick<
  PromoInput,
  'kind' | 'percent' | 'amount_pln' | 'amount_eur' | 'amount_gbp' | 'starts_at' | 'expires_at'
>;

/** Mirrors the SQL CHECKs in 20260830120000_promo_codes.sql. Returns field → message. */
function crossFieldErrors(rec: CrossFieldRecord): Record<string, string> {
  const errors: Record<string, string> = {};
  if (rec.kind === 'percent' && rec.percent == null) {
    errors.percent = 'Procent jest wymagany dla promocji procentowej.';
  }
  if (
    rec.kind === 'fixed' &&
    (rec.amount_pln == null || rec.amount_eur == null || rec.amount_gbp == null)
  ) {
    errors.amount_pln = 'Promocja kwotowa wymaga kwot we wszystkich trzech walutach.';
  }
  if (
    rec.starts_at != null &&
    rec.expires_at != null &&
    Date.parse(rec.starts_at) >= Date.parse(rec.expires_at)
  ) {
    errors.expires_at = 'Koniec obowiązywania musi być późniejszy niż początek.';
  }
  return errors;
}

/** CREATE parse schema: field-level rules + the cross-field refinement. */
export const promoCreateSchema = promoInputSchema.superRefine((data, ctx) => {
  for (const [field, message] of Object.entries(crossFieldErrors(data))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  }
});

/**
 * PATCH parse schema: partial fields + the `active` toggle. `code` stays IN
 * the shape (optional) so a rename attempt reaches updatePromotion and gets a
 * specific 400 `code_immutable` instead of being silently stripped. No
 * cross-field refinement at parse time — rules that span omitted fields can
 * only be checked on the merged record (updatePromotion owns that).
 */
export const promoPatchSchema = promoInputSchema.partial().extend({
  active: z.boolean().optional(),
});
export type PromoPatch = z.infer<typeof promoPatchSchema>;

export interface PromoStats {
  pending: number;
  redeemed: number;
  released: number;
  /** Sum of orders.discount over paid+refunded orders with this code, per currency. */
  discount_given_minor: { pln: number; eur: number; gbp: number };
  /** Sum of orders.total over paid+refunded orders with this code, per currency. */
  revenue_minor: { pln: number; eur: number; gbp: number };
  last_redeemed_at: string | null;
}
export type PromoWithStats = PromoCode & { stats: PromoStats };

export type PromoActionResult = { status: number; body: Record<string, unknown> };

const zeroStats = (): PromoStats => ({
  pending: 0,
  redeemed: 0,
  released: 0,
  discount_given_minor: { pln: 0, eur: 0, gbp: 0 },
  revenue_minor: { pln: 0, eur: 0, gbp: 0 },
  last_redeemed_at: null,
});

/**
 * Reads every row matching `build`, paginating past PostgREST's `max_rows`
 * cap (1000 on Supabase-hosted projects) via `.range()` — a promo's
 * lifetime redemption/order count can exceed that, and a single-page read
 * would silently understate stats instead of erroring.
 */
async function selectAllRows<T>(
  build: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  errorPrefix: string,
): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${errorPrefix}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/** All promotions (newest first) with live stats from the redemption ledger + orders join. */
export async function listPromotions(supabase: SupabaseClient): Promise<PromoWithStats[]> {
  const { data: promoData, error: promoErr } = await supabase
    .from('promo_codes')
    .select('*')
    .order('created_at', { ascending: false });
  if (promoErr) throw new Error(`list promotions failed: ${promoErr.message}`);
  const promos = (promoData ?? []) as PromoCode[];
  if (promos.length === 0) return [];

  const redemptions = await selectAllRows<{
    promo_id: string;
    status: 'pending' | 'redeemed' | 'released';
    settled_at: string | null;
  }>(
    async (from, to) =>
      await supabase
        .from('promo_redemptions')
        .select('promo_id, status, settled_at')
        .in('promo_id', promos.map((p) => p.id))
        .range(from, to),
    'list redemptions failed',
  );

  const orders = await selectAllRows<{
    promo_code: string;
    currency: string;
    discount: number | null;
    total: number | null;
  }>(
    async (from, to) =>
      await supabase
        .from('orders')
        .select('promo_code, currency, discount, total')
        .in('status', ['paid', 'refunded'])
        .in('promo_code', promos.map((p) => p.code))
        .range(from, to),
    'list promo orders failed',
  );

  const byId = new Map<string, PromoStats>();
  const statsFor = (id: string) => {
    let s = byId.get(id);
    if (!s) {
      s = zeroStats();
      byId.set(id, s);
    }
    return s;
  };
  for (const r of redemptions) {
    const s = statsFor(r.promo_id);
    if (r.status === 'pending') s.pending += 1;
    else if (r.status === 'redeemed') {
      s.redeemed += 1;
      if (r.settled_at && (!s.last_redeemed_at || r.settled_at > s.last_redeemed_at)) {
        s.last_redeemed_at = r.settled_at;
      }
    } else s.released += 1;
  }
  const byCode = new Map(promos.map((p) => [p.code, p.id]));
  for (const o of orders) {
    const id = byCode.get(o.promo_code);
    if (!id) continue;
    const s = statsFor(id);
    const cur = o.currency === 'eur' ? 'eur' : o.currency === 'gbp' ? 'gbp' : 'pln';
    s.discount_given_minor[cur] += o.discount ?? 0;
    s.revenue_minor[cur] += o.total ?? 0;
  }

  return promos.map((p) => ({ ...p, stats: byId.get(p.id) ?? zeroStats() }));
}

function mapUniqueViolation(error: { code?: string; message?: string }): PromoActionResult | null {
  if (error.code !== '23505') return null;
  if ((error.message ?? '').includes('newsletter_welcome')) {
    return { status: 409, body: { error: 'newsletter_welcome_taken' } };
  }
  return { status: 409, body: { error: 'code_exists' } };
}

/** Audit failures are logged, never fatal — the mutation already committed. */
async function writePromoAudit(
  supabase: SupabaseClient,
  code: string,
  action: 'promo:create' | 'promo:update',
  entry: { actor_email: string | null; before: unknown; after: unknown },
): Promise<void> {
  const res = await supabase.from('catalog_audit_log').insert({
    product_id: `promo:${code}`,
    action,
    ...entry,
  });
  if (res.error) console.error('[admin/promotions] audit write failed', res.error.message);
}

export async function createPromotion(
  supabase: SupabaseClient,
  input: PromoInput,
  actorEmail: string | null,
): Promise<PromoActionResult> {
  const code = normalizePromoCode(input.code);
  if (!code) return { status: 400, body: { error: 'invalid_code' } };

  const { data, error } = await supabase
    .from('promo_codes')
    .insert({
      code,
      kind: input.kind,
      percent: input.percent,
      amount_pln: input.amount_pln,
      amount_eur: input.amount_eur,
      amount_gbp: input.amount_gbp,
      applies_to: input.applies_to,
      starts_at: input.starts_at,
      expires_at: input.expires_at,
      max_redemptions: input.max_redemptions,
      newsletter_welcome: input.newsletter_welcome,
      campaign: input.campaign,
      created_by: actorEmail,
      updated_by: actorEmail,
    })
    .select('*')
    .maybeSingle();
  if (error) {
    const mapped = mapUniqueViolation(error);
    if (mapped) return mapped;
    console.error('[admin/promotions] create failed', error);
    return { status: 500, body: { error: 'promo_write_failed' } };
  }
  await writePromoAudit(supabase, code, 'promo:create', {
    actor_email: actorEmail,
    before: null,
    after: data,
  });
  return { status: 201, body: { promotion: data } };
}

export async function updatePromotion(
  supabase: SupabaseClient,
  id: string,
  patch: PromoPatch,
  actorEmail: string | null,
): Promise<PromoActionResult> {
  // Immutable identity: stats (orders.promo_code) and audit history
  // ('promo:'+code) would both be orphaned by a rename.
  if (patch.code !== undefined) {
    return { status: 400, body: { error: 'code_immutable' } };
  }

  const { data: currentData, error: loadErr } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) {
    console.error('[admin/promotions] load failed', loadErr);
    return { status: 500, body: { error: 'promo_write_failed' } };
  }
  if (!currentData) return { status: 404, body: { error: 'not_found' } };
  const current = currentData as PromoCode;

  // Purchase-minted codes represent a real transaction — read-only except the
  // `active` toggle (still needed to manually revoke one, mirroring the
  // automatic revoke-on-refund path). Any other field in the patch is rejected
  // outright rather than silently ignored.
  const { active, ...fields } = patch;
  if (current.source === 'gift_card' && Object.keys(fields).length > 0) {
    return { status: 400, body: { error: 'gift_card_code_readonly' } };
  }

  // Validate the MERGED record — cross-field rules span fields the patch may
  // omit, so only the merge result can be checked (never defer to a DB error).
  const merged: CrossFieldRecord = {
    kind: fields.kind ?? current.kind,
    percent: fields.percent !== undefined ? fields.percent : current.percent,
    amount_pln: fields.amount_pln !== undefined ? fields.amount_pln : current.amount_pln,
    amount_eur: fields.amount_eur !== undefined ? fields.amount_eur : current.amount_eur,
    amount_gbp: fields.amount_gbp !== undefined ? fields.amount_gbp : current.amount_gbp,
    starts_at: fields.starts_at !== undefined ? fields.starts_at : current.starts_at,
    expires_at: fields.expires_at !== undefined ? fields.expires_at : current.expires_at,
  };
  const errors = crossFieldErrors(merged);
  if (Object.keys(errors).length > 0) {
    return { status: 400, body: { error: 'validation_failed', fields: errors } };
  }

  const { data: after, error: updateErr } = await supabase
    .from('promo_codes')
    .update({
      ...fields,
      ...(active !== undefined ? { active } : {}),
      updated_at: new Date().toISOString(),
      updated_by: actorEmail,
    })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (updateErr) {
    const mapped = mapUniqueViolation(updateErr);
    if (mapped) return mapped;
    console.error('[admin/promotions] update failed', updateErr);
    return { status: 500, body: { error: 'promo_write_failed' } };
  }
  if (!after) return { status: 404, body: { error: 'not_found' } };

  await writePromoAudit(supabase, current.code, 'promo:update', {
    actor_email: actorEmail,
    before: current,
    after,
  });
  return { status: 200, body: { promotion: after } };
}
