import { normalizePromoCode } from './promo';

export const normalizeGiftCardCode = normalizePromoCode;
export type GiftCardCurrency = 'pln' | 'eur' | 'gbp';

/** Minimums when settlement uses the same currency. The caller must use the
 * verified settlement minimum (including conversion) when it is higher.
 * https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts */
export const STRIPE_MINIMUM_MINOR: Record<GiftCardCurrency, number> = { pln: 200, eur: 50, gbp: 30 };

function minor(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

export function splitGiftCardPayment(total: number, available: number, minimumCash: number) {
  minor(total, 'total'); minor(available, 'balance'); minor(minimumCash, 'minimum');
  if (total === 0 || minimumCash === 0) throw new Error('Invalid payment amount');
  let giftCard = Math.min(total, available);
  const remainder = total - giftCard;
  if (remainder > 0 && remainder < minimumCash) giftCard = Math.max(0, total - minimumCash);
  const cash = total - giftCard;
  if (cash > 0 && cash < minimumCash) throw new Error('Below minimum payment');
  return { total, giftCard, cash, balanceAfter: available - giftCard };
}

/** Split a cumulative refund target, then subtract amounts already returned.
 * Integer arithmetic avoids drifting a cent on repeated partial refunds. */
export function splitGiftCardRefund(args: {
  total: number; giftCard: number; refundedTotal: number; refundedGiftCard: number; refund: number;
}) {
  for (const [name, value] of Object.entries(args)) minor(value, name);
  const { total, giftCard, refundedTotal, refundedGiftCard, refund } = args;
  if (!total || !refund || giftCard > total || refundedTotal + refund > total ||
      refundedGiftCard > giftCard || refundedGiftCard > refundedTotal) throw new Error('Invalid refund');
  const target = BigInt(refundedTotal + refund);
  const cardTarget = Number((target * BigInt(giftCard) + BigInt(Math.floor(total / 2))) / BigInt(total));
  const card = cardTarget - refundedGiftCard;
  const cash = refund - card;
  if (card < 0 || cash < 0 || cash > total - giftCard - (refundedTotal - refundedGiftCard)) throw new Error('Inconsistent refund history');
  return { giftCard: card, cash };
}
