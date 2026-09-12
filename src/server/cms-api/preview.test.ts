import { describe, expect, it } from 'vitest';
import { mintProductPreviewToken, verifyProductPreviewToken } from './preview';

describe('product preview tokens', () => {
  it('round-trips a minted token', async () => {
    const { token } = await mintProductPreviewToken('secret', 'prd_1', 3);
    const payload = await verifyProductPreviewToken('secret', token);
    expect(payload).toEqual(expect.objectContaining({ kind: 'product', resourceId: 'prd_1', revision: 3 }));
  });

  it('rejects a token verified with the wrong secret', async () => {
    const { token } = await mintProductPreviewToken('secret', 'prd_1', 3);
    expect(await verifyProductPreviewToken('other-secret', token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await mintProductPreviewToken('secret', 'prd_1', 3, 900, Date.now() - 1_000_000);
    expect(await verifyProductPreviewToken('secret', token)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyProductPreviewToken('secret', 'not-a-token')).toBeNull();
  });
});
