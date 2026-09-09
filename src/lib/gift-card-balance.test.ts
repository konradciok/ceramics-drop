import { describe, expect, it } from 'vitest';
import { splitGiftCardPayment, splitGiftCardRefund } from './gift-card-balance';

describe('gift-card payment allocation', () => {
  it('covers products and shipping and retains the remainder', () => {
    expect(splitGiftCardPayment(14500, 20000, 200)).toEqual({ total: 14500, giftCard: 14500, cash: 0, balanceAfter: 5500 });
  });
  it('uses a remaining balance toward a larger order', () => {
    expect(splitGiftCardPayment(21000, 5500, 200)).toEqual({ total: 21000, giftCard: 5500, cash: 15500, balanceAfter: 0 });
  });
  it('leaves money on the card when a cash remainder would be too small', () => {
    expect(splitGiftCardPayment(20100, 20000, 200)).toEqual({ total: 20100, giftCard: 19900, cash: 200, balanceAfter: 100 });
  });
  it.each([-1, 1.5, NaN, Infinity])('rejects invalid monetary amounts: %s', (value) => {
    expect(() => splitGiftCardPayment(value, 20000, 200)).toThrow();
  });
});

describe('proportional refunds', () => {
  it('splits a partial refund between the original sources', () => {
    expect(splitGiftCardRefund({ total: 10000, giftCard: 4000, refundedTotal: 0, refundedGiftCard: 0, refund: 2500 })).toEqual({ giftCard: 1000, cash: 1500 });
  });
  it('conserves both original sources across many one-cent refunds', () => {
    let refundedTotal = 0; let refundedGiftCard = 0; let cash = 0;
    for (let i = 0; i < 101; i++) {
      const split = splitGiftCardRefund({ total: 101, giftCard: 37, refundedTotal, refundedGiftCard, refund: 1 });
      refundedTotal++; refundedGiftCard += split.giftCard; cash += split.cash;
    }
    expect({ refundedTotal, refundedGiftCard, cash }).toEqual({ refundedTotal: 101, refundedGiftCard: 37, cash: 64 });
  });
  it('refunds a fully card-paid order entirely to the card', () => {
    expect(splitGiftCardRefund({ total: 10000, giftCard: 10000, refundedTotal: 0, refundedGiftCard: 0, refund: 7000 })).toEqual({ giftCard: 7000, cash: 0 });
  });
  it('rejects an over-refund or inconsistent history', () => {
    expect(() => splitGiftCardRefund({ total: 10000, giftCard: 4000, refundedTotal: 8000, refundedGiftCard: 3200, refund: 3000 })).toThrow();
    expect(() => splitGiftCardRefund({ total: 10000, giftCard: 4000, refundedTotal: 1000, refundedGiftCard: 1000, refund: 1 })).toThrow();
  });
});
