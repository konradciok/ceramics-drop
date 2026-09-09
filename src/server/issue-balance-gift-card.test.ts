import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueBalanceGiftCard } from './issue-balance-gift-card';
import { emailGiftCardToCustomer } from '@/lib/email';

vi.mock('@/lib/email', () => ({ emailGiftCardToCustomer: vi.fn(async () => ({ id: 'mail-test' })) }));
const order = { id: 'order-test', email: 'buyer@example.invalid', receiver_first_name: 'Test', currency: 'eur', locale: 'en' };
const items = [{ variant: { kind: 'giftcard', tierId: 'gc-200' } }];
const env = {} as CloudflareEnv;

describe('balance card issuance', () => {
  beforeEach(() => vi.clearAllMocks());
  it('sends the durable code and paid denomination, rather than the current price table', async () => {
    const rpc = vi.fn(async () => ({ data: { code: 'GIFT-PERSISTED', initial_amount: 12345 }, error: null }));
    await issueBalanceGiftCard(order, items, { rpc } as never, env);
    expect(rpc).toHaveBeenCalledWith('issue_gift_card', { p_order_id: order.id, p_code: expect.stringMatching(/^GIFT-[A-Z2-9]{20}$/) });
    expect(emailGiftCardToCustomer).toHaveBeenCalledWith(expect.objectContaining({ code: 'GIFT-PERSISTED', amountMinor: 12345, idempotencyKey: 'gift-card-delivery/order-test' }));
  });
  it('retries a code collision with fresh entropy, then delivers once', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ error: { code: '23505' } })
      .mockResolvedValueOnce({ data: { code: 'GIFT-DURABLE', initial_amount: 10000 }, error: null });
    await issueBalanceGiftCard(order, items, { rpc } as never, env);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_code).not.toBe(rpc.mock.calls[1][1].p_code);
    expect(emailGiftCardToCustomer).toHaveBeenCalledOnce();
  });
  it('bounds collisions and propagates failure for durable recovery', async () => {
    const rpc = vi.fn(async () => ({ error: { code: '23505' } }));
    await expect(issueBalanceGiftCard(order, items, { rpc } as never, env)).rejects.toThrow('requires retry');
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(emailGiftCardToCustomer).not.toHaveBeenCalled();
  });
  it('never mints or sends when the paid order has no gift-card line', async () => {
    const rpc = vi.fn();
    await expect(issueBalanceGiftCard(order, [], { rpc } as never, env)).rejects.toThrow('line missing');
    expect(rpc).not.toHaveBeenCalled();
    expect(emailGiftCardToCustomer).not.toHaveBeenCalled();
  });
});
