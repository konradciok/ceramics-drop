import { describe, expect, it } from 'vitest';
import { mintProductPreviewToken, verifyProductPreviewToken, mintContentPreviewToken, verifyContentPreviewToken } from './preview';

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

describe('content preview tokens', () => {
  it('round-trips a minted token', async () => {
    const { token } = await mintContentPreviewToken('secret', 'product_notes:kubki:pl', 2);
    const payload = await verifyContentPreviewToken('secret', token);
    expect(payload).toEqual(expect.objectContaining({ kind: 'content', resourceId: 'product_notes:kubki:pl', revision: 2 }));
  });

  it('rejects a token verified with the wrong secret', async () => {
    const { token } = await mintContentPreviewToken('secret', 'product_notes:kubki:pl', 2);
    expect(await verifyContentPreviewToken('other-secret', token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await mintContentPreviewToken('secret', 'product_notes:kubki:pl', 2, 900, Date.now() - 1_000_000);
    expect(await verifyContentPreviewToken('secret', token)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyContentPreviewToken('secret', 'not-a-token')).toBeNull();
  });

  it('a content token does not verify as a product token, and vice versa (discriminated by kind)', async () => {
    const { token: contentToken } = await mintContentPreviewToken('secret', 'product_notes:kubki:pl', 2);
    expect(await verifyProductPreviewToken('secret', contentToken)).toBeNull();
    const { token: productToken } = await mintProductPreviewToken('secret', 'prd_1', 3);
    expect(await verifyContentPreviewToken('secret', productToken)).toBeNull();
  });
});
