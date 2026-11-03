import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { normalizeGiftCardCode } from '@/lib/gift-card-balance';
import { currencyFromCookieHeader, toChargeableCurrency } from '@/lib/currency';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';

export const dynamic = 'force-dynamic';
const limiter = createCheckoutRateLimiter();
const trustForwarded = process.env.NODE_ENV !== 'production';

export async function POST(req: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const ip = getClientIp(req, { trustForwarded })?.trim() || (trustForwarded ? null : 'unknown');
  const rate = limiter.allow(ip);
  if (!rate.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(rate.retryAfterSeconds) } });
  let code: string | null;
  let locale: string;
  try {
    const body = await req.json();
    code = normalizeGiftCardCode(body?.code);
    locale = ['pl','en','es','de'].includes(body?.locale) ? body.locale : 'pl';
  } catch { return NextResponse.json({ error: 'gift_card_invalid' }, { status: 400, headers }); }
  if (!code) return NextResponse.json({ error: 'gift_card_invalid' }, { status: 400, headers });
  try {
    const db = getSupabaseAdmin();
    const settings = await db.from('gift_card_settings').select('spending_enabled').eq('singleton', true).single();
    if (settings.error || !settings.data.spending_enabled) return NextResponse.json({ error: 'gift_card_unavailable' }, { status: 503, headers });
    const { data: card, error } = await db.from('gift_cards').select('id,currency,balance,status').eq('code', code).maybeSingle();
    if (error) throw error;
    if (!card || card.status !== 'active') return NextResponse.json({ error: 'gift_card_invalid' }, { status: 400, headers });
    const currency = toChargeableCurrency(currencyFromCookieHeader(locale, req.headers.get('cookie')));
    if (card.currency !== currency) return NextResponse.json({ error: 'gift_card_currency', currency: card.currency.toUpperCase() }, { status: 400, headers });
    const holds = await db.from('gift_card_holds').select('amount').eq('card_id', card.id).eq('status', 'held');
    if (holds.error) throw holds.error;
    const available = Math.max(0, card.balance - (holds.data ?? []).reduce((sum, hold) => sum + hold.amount, 0));
    // Preview only. The atomic checkout rechecks balance, holds and currency.
    return NextResponse.json({ code, currency, available }, { headers });
  } catch { return NextResponse.json({ error: 'gift_card_unavailable' }, { status: 503, headers }); }
}
