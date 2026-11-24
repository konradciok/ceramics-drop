import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completePaidOrder } from './complete-paid-order';

const effects = vi.hoisted(() => ({ invoice: vi.fn(), confirmation: vi.fn(), studio: vi.fn(), purchased: vi.fn(), issue: vi.fn(), subscribe: vi.fn() }));
vi.mock('@/lib/invoice', () => ({ createInvoiceForOrder: effects.invoice }));
vi.mock('@/lib/email', () => ({ emailOrderConfirmationToCustomer: effects.confirmation, emailNewOrderToStudio: effects.studio }));
vi.mock('@/lib/resend-events', () => ({ sendPurchasedEvent: effects.purchased }));
vi.mock('./issue-balance-gift-card', () => ({ issueBalanceGiftCard: effects.issue }));
vi.mock('@/lib/newsletter', () => ({ subscribeNewsletterContact: effects.subscribe }));
vi.mock('@/lib/admin/actions', () => ({ createShipmentForOrder: vi.fn() }));
vi.mock('@/lib/inpost', () => ({ inpostFromEnv: vi.fn() }));

function fixture() {
  const order: Record<string, unknown> = { id: 'o1', status: 'paid', fulfilment_type: 'prodigi', email: 'test@example.invalid', locale: 'en', total: 10000,
    currency: 'eur', gift_card_amount: 10000, gift_card_balance_after: 2500, payment_intent_id: null,
    paid_processing_claim: null, paid_processing_completed_at: null, confirmation_email_sent_at: null, studio_email_sent_at: null };
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const resolve = () => {
      if (table === 'order_items') return { data: [{ product_id: 'fap01', unit_price: 10000, variant: { kind: 'print' } }], error: null };
      if (!filters.every(([key, value]) => order[key] === value)) return { data: [], error: null };
      if (patch) Object.assign(order, patch);
      return { data: [{ ...order }], error: null };
    };
    const node = {
      update: (data: Record<string, unknown>) => { patch = data; return node; },
      select: () => node,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return node; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return node; },
      or: () => node,
      maybeSingle: async () => { const result = resolve(); return { ...result, data: result.data[0] ?? null }; },
      then: (success: (value: unknown) => unknown) => Promise.resolve(resolve()).then(success),
    };
    return node;
  };
  const supabase = { from };
  return { order, supabase, deps: { supabase, stripe: {}, env: {}, ctx: {} } as never };
}

describe('paid-order recovery', () => {
  beforeEach(() => { for (const effect of Object.values(effects)) effect.mockReset().mockResolvedValue(undefined); });
  it('fulfils a fully balance-funded order by its order id and completes it once', async () => {
    const f = fixture();
    expect(await completePaidOrder('o1', f.deps)).toBe(true);
    expect(effects.invoice).toHaveBeenCalledWith({ orderId: 'o1' }, expect.objectContaining({ supabase: f.supabase }));
    expect(effects.confirmation).toHaveBeenCalledWith(expect.objectContaining({ order: expect.objectContaining({ payment: expect.objectContaining({ gift_card_amount: 10000 }) }) }));
    expect(await completePaidOrder('o1', f.deps)).toBe(false);
    expect(effects.confirmation).toHaveBeenCalledOnce();
  });
  it('leaves a failed invoice retryable, without marking missing emails as sent', async () => {
    const f = fixture(); effects.invoice.mockRejectedValueOnce(new Error('invoice unavailable'));
    await expect(completePaidOrder('o1', f.deps)).rejects.toThrow('invoice unavailable');
    expect(f.order.paid_processing_claim).toBeNull(); expect(f.order.paid_processing_completed_at).toBeNull();
    expect(f.order.confirmation_email_sent_at).toBeNull();
    expect(await completePaidOrder('o1', f.deps)).toBe(true);
  });
  it('retries a failed studio email without resending the customer confirmation', async () => {
    const f = fixture(); effects.studio.mockRejectedValueOnce(new Error('mail unavailable'));
    await expect(completePaidOrder('o1', f.deps)).rejects.toThrow('mail unavailable');
    expect(await completePaidOrder('o1', f.deps)).toBe(true);
    expect(effects.confirmation).toHaveBeenCalledOnce(); expect(effects.studio).toHaveBeenCalledTimes(2);
  });
  it('issues a gift-card purchase through its dedicated code email', async () => {
    const f = fixture(); f.order.fulfilment_type = 'giftcard'; f.order.gift_card_amount = 0;
    expect(await completePaidOrder('o1', f.deps)).toBe(true);
    expect(effects.issue).toHaveBeenCalledOnce(); expect(effects.confirmation).not.toHaveBeenCalled();
  });
});

describe('paid-order marketing opt-in', () => {
  const segmentEnv = { RESEND_API_KEY: 're_test', RESEND_MARKETING_SEGMENT_ID: 'seg-1' };
  const withEnv = (f: ReturnType<typeof fixture>, env: Record<string, string>) =>
    ({ ...(f.deps as unknown as Record<string, unknown>), env }) as never;
  beforeEach(() => { for (const effect of Object.values(effects)) effect.mockReset().mockResolvedValue(undefined); });

  it('adds a buyer who ticked the consent to the marketing segment', async () => {
    const f = fixture(); f.order.marketing = { consent: 'denied', email_opt_in: true, email_opt_in_at: '2026-11-24T10:00:00.000Z' };
    expect(await completePaidOrder('o1', withEnv(f, segmentEnv))).toBe(true);
    expect(effects.subscribe).toHaveBeenCalledWith({ apiKey: 're_test', email: 'test@example.invalid', segmentId: 'seg-1' });
  });

  it('leaves buyers without the consent (or older orders) alone', async () => {
    for (const marketing of [{ consent: 'granted', email_opt_in: false }, { consent: 'granted' }, null]) {
      const f = fixture(); f.order.marketing = marketing;
      expect(await completePaidOrder('o1', withEnv(f, segmentEnv))).toBe(true);
    }
    expect(effects.subscribe).not.toHaveBeenCalled();
  });

  it('skips the sync when the segment is not configured', async () => {
    const f = fixture(); f.order.marketing = { consent: 'denied', email_opt_in: true };
    expect(await completePaidOrder('o1', withEnv(f, { RESEND_API_KEY: 're_test' }))).toBe(true);
    expect(effects.subscribe).not.toHaveBeenCalled();
  });

  it('still completes the order when Resend fails', async () => {
    const f = fixture(); f.order.marketing = { consent: 'denied', email_opt_in: true };
    effects.subscribe.mockRejectedValueOnce(new Error('Resend 500'));
    expect(await completePaidOrder('o1', withEnv(f, segmentEnv))).toBe(true);
    expect(f.order.paid_processing_completed_at).not.toBeNull();
  });
});
