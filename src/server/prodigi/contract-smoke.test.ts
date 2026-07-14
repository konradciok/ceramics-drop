import { describe, expect, it, vi } from 'vitest';
import { runProdigiContractSmoke, type ContractClient, type ContractSmokeDeps } from './contract-smoke';
import type { ProdigiOrderRequest } from './types';

const PAYLOAD: ProdigiOrderRequest = {
  shippingMethod: 'Budget',
  idempotencyKey: 'test-key',
  merchantReference: 'contract-smoke-test',
  recipient: {
    name: 'Test',
    address: { line1: '1 Test St', postalOrZipCode: '00-001', countryCode: 'PL', townOrCity: 'Warsaw' },
  },
  items: [{ sku: 'GLOBAL-FAP-12X16', copies: 1, sizing: 'fillPrintArea', assets: [{ printArea: 'default', url: 'https://example.invalid/a.jpg' }] }],
};

type FakeOverrides = Partial<{
  created: { order?: { id?: string; status?: { stage?: string }; items?: Array<{ id?: string; sku?: string }> }; outcome?: string };
  gotStage: string;
  gotMerchantReference?: string | null;
  cancelAvailable: string;
  cancelOutcome: string;
  throwIn?: 'postOrder' | 'getOrder' | 'getOrderActions' | 'cancelOrder';
}>;

function buildDeps(overrides: FakeOverrides = {}): { deps: ContractSmokeDeps; client: ContractClient & { cancelOrder: ReturnType<typeof vi.fn> } } {
  const o = {
    created: overrides.created ?? {
      outcome: 'Created',
      order: { id: 'ord_1', status: { stage: 'InProgress' }, items: [{ id: 'item_1', sku: 'GLOBAL-FAP-12X16' }] },
    },
    gotStage: overrides.gotStage ?? 'InProgress',
    gotMerchantReference: overrides.gotMerchantReference ?? PAYLOAD.merchantReference,
    cancelAvailable: overrides.cancelAvailable ?? 'Yes',
    cancelOutcome: overrides.cancelOutcome ?? 'Cancelled',
    throwIn: overrides.throwIn,
  };
  const client = {
    postOrder: vi.fn(async () => {
      if (o.throwIn === 'postOrder') throw new Error('boom postOrder');
      return o.created as never;
    }),
    getOrder: vi.fn(async () => {
      if (o.throwIn === 'getOrder') throw new Error('boom getOrder');
      return { order: { id: 'ord_1', status: { stage: o.gotStage }, merchantReference: o.gotMerchantReference ?? undefined } } as never;
    }),
    getOrderActions: vi.fn(async () => {
      if (o.throwIn === 'getOrderActions') throw new Error('boom actions');
      return { outcome: 'OK', cancel: { isAvailable: o.cancelAvailable } } as never;
    }),
    cancelOrder: vi.fn(async () => {
      if (o.throwIn === 'cancelOrder') throw new Error('boom cancel');
      return { outcome: o.cancelOutcome } as never;
    }),
  };
  const mapStage = vi.fn((stage: string) => (stage === 'InProgress' || stage === 'InProduction' || stage === 'Complete' || stage === 'Cancelled' ? 'ok' : null));
  return { deps: { client, payload: PAYLOAD, mapStage }, client: client as never };
}

describe('runProdigiContractSmoke', () => {
  it('passes on a well-shaped lifecycle and cancels the order', async () => {
    const { deps, client } = buildDeps();
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(true);
    expect(res.prodigiOrderId).toBe('ord_1');
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
    expect(res.steps.every((s) => s.ok)).toBe(true);
  });

  it('fails loudly and skips cancel when postOrder returns no order.id', async () => {
    const { deps, client } = buildDeps({ created: { outcome: 'Created', order: { status: { stage: 'InProgress' } } } });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.prodigiOrderId).toBeUndefined();
    expect(res.cancelled).toBe(false);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    const createFail = res.steps.find((s) => s.step === 'create:id' && !s.ok);
    expect(createFail).toBeTruthy();
  });

  it('fails on an unrecognised status.stage but still cancels (order was created)', async () => {
    const { deps, client } = buildDeps({ gotStage: 'SomeNewStage' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
    const mapFail = res.steps.find((s) => s.step === 'mapStage' && !s.ok);
    expect(mapFail).toBeTruthy();
  });

  it('fails when cancel.isAvailable is not Yes', async () => {
    const { deps } = buildDeps({ cancelAvailable: 'No' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    const actFail = res.steps.find((s) => s.step === 'actions:cancel' && !s.ok);
    expect(actFail).toBeTruthy();
  });

  it('accepts cancel outcome case-insensitively', async () => {
    const { deps } = buildDeps({ cancelOutcome: 'cancelled' });
    const res = await runProdigiContractSmoke(deps);
    const cancelStep = res.steps.find((s) => s.step === 'cancel');
    expect(cancelStep?.ok).toBe(true);
  });

  it('cancels even when a lifecycle step throws', async () => {
    const { deps, client } = buildDeps({ throwIn: 'getOrder' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
  });

  it('surfaces a cancel failure without masking the other steps', async () => {
    const { deps, client } = buildDeps({ throwIn: 'cancelOrder' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.cancelled).toBe(false);
    expect(res.ok).toBe(false);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
    const cancelStep = res.steps.find((s) => s.step === 'cancel');
    expect(cancelStep?.ok).toBe(false);
    // lifecycle steps stayed green — the cancel failure didn't mask them
    const nonCancelOk = res.steps.filter((s) => s.step !== 'cancel').every((s) => s.ok);
    expect(nonCancelOk).toBe(true);
  });

  it('fails when getOrder does not echo the merchantReference we sent', async () => {
    const { deps } = buildDeps({ gotMerchantReference: 'wrong' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    const mrFail = res.steps.find((s) => s.step === 'getOrder:merchantReference' && !s.ok);
    expect(mrFail).toBeTruthy();
  });
});
