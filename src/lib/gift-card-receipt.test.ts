import { describe,it,expect } from 'vitest';
import { createGiftCardReceipt,verifyGiftCardReceipt } from './gift-card-receipt';
describe('gift-card order receipt',()=>{
  it('binds access to a specific order and rejects tampering, expiry and a wrong key',async()=>{
    const now=Date.parse('2026-09-09T12:00:00Z');
    const token=await createGiftCardReceipt('order-one','test-only-secret',now);
    expect(await verifyGiftCardReceipt('order-one',token,'test-only-secret',now)).toBe(true);
    expect(await verifyGiftCardReceipt('order-two',token,'test-only-secret',now)).toBe(false);
    expect(await verifyGiftCardReceipt('order-one',token,'wrong-key',now)).toBe(false);
    expect(await verifyGiftCardReceipt('order-one',token,'test-only-secret',now+8*86400_000)).toBe(false);
    expect(await verifyGiftCardReceipt('order-one',token.replace(/^./,'9'),'test-only-secret',now)).toBe(false);
  });
});
