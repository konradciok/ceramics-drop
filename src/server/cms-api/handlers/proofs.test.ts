import { describe, expect, it, vi } from 'vitest';
import { proofDecisionRoute } from './proofs';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';

vi.mock('../mapping');

function req(body: unknown) {
  return new Request('https://x.test/v1/products/fap001/proofs/asset-1', { method: 'POST', body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('proofDecisionRoute', () => {
  it('requires expectedRevision and a valid action', async () => {
    const res = await proofDecisionRoute.handler(req({ action: 'nope' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('maps proof_not_found to 404', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'proof_not_found' } });
    const res = await proofDecisionRoute.handler(req({ expectedRevision: 1, action: 'approve' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(rpc));
    expect(res.status).toBe(404);
  });

  it('maps revision_conflict to 409', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'revision_conflict', details: 'currentRevision=4' } });
    const res = await proofDecisionRoute.handler(req({ expectedRevision: 1, action: 'approve' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(4);
  });

  it('maps invalid_proof_transition to 409', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'invalid_proof_transition' } });
    const res = await proofDecisionRoute.handler(req({ expectedRevision: 1, action: 'reject' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_PROOF_TRANSITION');
  });

  it('rejects when the RPC-returned productId does not match the path id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, productId: 'fap999' }, error: null });
    const res = await proofDecisionRoute.handler(req({ expectedRevision: 1, action: 'approve' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(rpc));
    expect(res.status).toBe(404);
  });

  it('succeeds and returns the reloaded product', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, productId: 'fap001' }, error: null });
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ id: 'fap001' } as never);
    const res = await proofDecisionRoute.handler(req({ expectedRevision: 1, action: 'approve' }), {} as CloudflareEnv, { id: 'fap001', proofId: 'asset-1' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('decide_print_proof', { p_asset_id: 'asset-1', p_action: 'approve', p_expected_revision: 1, p_actor_email: 'anna@studio.pl' });
  });
});
