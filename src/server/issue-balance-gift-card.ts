import type { SupabaseClient } from '@supabase/supabase-js';
import { generateGiftCardCode, getGiftCardTier, isGiftCardOrderItemVariant } from '@/lib/gift-cards';
import { emailGiftCardToCustomer } from '@/lib/email';

export async function issueBalanceGiftCard(order: {
  id: string; email: string | null; receiver_first_name: string | null; currency: string; locale: string | null;
}, items: Array<{ variant: unknown }>, supabase: SupabaseClient, env: CloudflareEnv): Promise<void> {
  const item = items.find(item => isGiftCardOrderItemVariant(item.variant));
  if (!item || !isGiftCardOrderItemVariant(item.variant)) throw new Error('Gift card line missing');
  const tier = getGiftCardTier(item.variant.tierId);
  if (!tier) throw new Error('Gift card tier missing');
  if (order.currency !== 'pln' && order.currency !== 'eur' && order.currency !== 'gbp') throw new Error('Gift card currency unsupported');
  let card: { code: string; initial_amount: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 100 random bits for new balance-bearing codes; existing short codes are
    // preserved by migration. No code enters URLs, telemetry or logs.
    const code = generateGiftCardCode(() => crypto.getRandomValues(new Uint8Array(20)));
    const result = await supabase.rpc('issue_gift_card', { p_order_id: order.id, p_code: code });
    if (!result.error) { card = result.data; break; }
    if (result.error.code !== '23505') throw new Error('Gift card issuance requires retry');
  }
  if (!card) throw new Error('Gift card issuance requires retry');
  await emailGiftCardToCustomer({ order, tier, currency: order.currency, amountMinor: card.initial_amount,
    code: card.code, locale: order.locale ?? 'pl', env, idempotencyKey: `gift-card-delivery/${order.id}` });
}
