import type {
  ProdigiCancelResponse,
  ProdigiOrderActionsResponse,
  ProdigiOrderRequest,
  ProdigiOrderResponse,
} from './types';

/** Structural subset of the prodigiClient the orchestrator needs. */
export interface ContractClient {
  postOrder: (payload: ProdigiOrderRequest) => Promise<ProdigiOrderResponse>;
  getOrder: (id: string) => Promise<{ order: ProdigiOrderResponse['order'] }>;
  getOrderActions: (id: string) => Promise<ProdigiOrderActionsResponse>;
  cancelOrder: (id: string) => Promise<ProdigiCancelResponse>;
}

export interface ContractSmokeDeps {
  client: ContractClient;
  payload: ProdigiOrderRequest;
  /** mapProdigiStage injected so the orchestrator is unit-testable without status-map. */
  mapStage: (stage: string) => string | null;
}

export type SmokeStep = { step: string; ok: true } | { step: string; ok: false; reason: string };

export interface SmokeResult {
  ok: boolean;
  prodigiOrderId?: string;
  steps: SmokeStep[];
  cancelled: boolean;
}

/**
 * Drive a real Prodigi sandbox lifecycle through the injected client and assert
 * every response field the fulfilment path (processJob / handleProdigiCallback)
 * actually reads. This is the H-1 contract check: Prodigi accepts our payload and
 * we accept Prodigi's response. **Always cancels in `finally`** so a sandbox
 * order is never left behind, even when an assertion fails.
 */
export async function runProdigiContractSmoke(deps: ContractSmokeDeps): Promise<SmokeResult> {
  const { client, payload, mapStage } = deps;
  const steps: SmokeStep[] = [];
  let prodigiOrderId: string | undefined;
  let cancelled = false;
  let realStage: string | undefined;

  try {
    const created = await client.postOrder(payload);
    prodigiOrderId = created.order?.id;
    steps.push(
      created.outcome
        ? { step: 'create:outcome', ok: true }
        : { step: 'create:outcome', ok: false, reason: 'postOrder response missing outcome' },
    );
    steps.push(
      prodigiOrderId && typeof prodigiOrderId === 'string'
        ? { step: 'create:id', ok: true }
        : { step: 'create:id', ok: false, reason: `postOrder response missing order.id: ${JSON.stringify(created)}` },
    );
    const stage0 = created.order?.status?.stage;
    steps.push(
      typeof stage0 === 'string'
        ? { step: 'create:stage', ok: true }
        : { step: 'create:stage', ok: false, reason: 'postOrder response missing order.status.stage' },
    );
    const item0 = created.order?.items?.[0];
    steps.push(
      item0?.id && item0?.sku
        ? { step: 'create:items', ok: true }
        : { step: 'create:items', ok: false, reason: 'postOrder response missing order.items[0].id/sku' },
    );

    if (prodigiOrderId) {
      const got = await client.getOrder(prodigiOrderId);
      steps.push(
        got.order?.id === prodigiOrderId
          ? { step: 'getOrder:id', ok: true }
          : { step: 'getOrder:id', ok: false, reason: `getOrder order.id mismatch (got ${got.order?.id}, expected ${prodigiOrderId})` },
      );
      realStage = got.order?.status?.stage;
      steps.push(
        typeof realStage === 'string'
          ? { step: 'getOrder:stage', ok: true }
          : { step: 'getOrder:stage', ok: false, reason: 'getOrder response missing order.status.stage' },
      );

      const actions = await client.getOrderActions(prodigiOrderId);
      steps.push(
        actions.cancel?.isAvailable === 'Yes'
          ? { step: 'actions:cancel', ok: true }
          : { step: 'actions:cancel', ok: false, reason: `cancel.isAvailable='${actions.cancel?.isAvailable ?? 'missing'}' (expected 'Yes')` },
      );

      if (typeof realStage === 'string') {
        const mapped = mapStage(realStage);
        steps.push(
          mapped !== null
            ? { step: 'mapStage', ok: true }
            : { step: 'mapStage', ok: false, reason: `mapProdigiStage('${realStage}') returned null — unrecognised stage (schema drift)` },
        );
      }
    }
  } catch (e) {
    steps.push({ step: 'lifecycle', ok: false, reason: e instanceof Error ? e.message : String(e) });
  } finally {
    if (prodigiOrderId) {
      try {
        const cancel = await client.cancelOrder(prodigiOrderId);
        cancelled = true;
        const outcome = String(cancel.outcome ?? '').toLowerCase();
        steps.push(
          outcome === 'cancelled'
            ? { step: 'cancel', ok: true }
            : { step: 'cancel', ok: false, reason: `cancel outcome='${cancel.outcome}' (expected 'Cancelled', case-insensitive)` },
        );
      } catch (e) {
        // Order was created but cancel failed — surface it; do NOT mask other failures.
        steps.push({ step: 'cancel', ok: false, reason: `cancel threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  return { ok: steps.length > 0 && steps.every((s) => s.ok), prodigiOrderId, steps, cancelled };
}
