import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTerminalStatus, mapProdigiStage } from './status-map';
import { buildProdigiPayload } from '../prodigi/mapper';
import { signPrintAssetUrl } from '@/lib/print-assets';
import { SITE_URL } from '@/lib/site';

describe('mapProdigiStage', () => {
  it('maps InProduction', () => expect(mapProdigiStage('InProduction')).toBe('in_production'));
  it('maps Complete to shipped', () => expect(mapProdigiStage('Complete')).toBe('shipped'));
  it('returns null for unknown stages so they never downgrade a job', () =>
    expect(mapProdigiStage('Pending')).toBeNull());
});

describe('isTerminalStatus', () => {
  it('treats completed as terminal', () => expect(isTerminalStatus('completed')).toBe(true));
  it('treats shipped as terminal', () => expect(isTerminalStatus('shipped')).toBe(true));
  it('does not treat in_production as terminal', () => expect(isTerminalStatus('in_production')).toBe(false));
});

// ── processJob guard tests ────────────────────────────────────────────────────

const { mockFrom, mockPostOrder, mockGetAssetForFulfilment, mockCaptureAlert, mockStudioEmail } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockPostOrder: vi.fn(),
  mockGetAssetForFulfilment: vi.fn(),
  mockCaptureAlert: vi.fn(async () => {}),
  mockStudioEmail: vi.fn(async () => {}),
}));

// C-2 guard: the queue runs OUTSIDE the request ALS, so getSupabaseAdmin() (which
// resolves getCloudflareContext()) throws there. Mock it to throw and provide the
// env-based client instead — processJob must build its client via supabaseFromEnv(env).
vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => {
    throw new Error('getCloudflareContext outside ALS');
  },
}));
vi.mock('../prodigi/client', async (importOriginal) => {
  // Spread the real module so ProdigiError is the real class — any change to its
  // constructor signature surfaces here instead of silently passing a stand-in.
  const actual = await importOriginal<typeof import('../prodigi/client')>();
  return { ...actual, prodigiClient: vi.fn(() => ({ postOrder: mockPostOrder })) };
});
vi.mock('../prodigi/mapper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prodigi/mapper')>();
  return { ...actual, buildProdigiPayload: vi.fn(() => ({})) };
});
vi.mock('@/lib/print-assets', () => ({ signPrintAssetUrl: vi.fn().mockResolvedValue('https://cdn.example.com/asset.jpg') }));
vi.mock('@/lib/worker-sentry', () => ({ captureWorkerAlert: mockCaptureAlert }));
vi.mock('@/lib/studio-alert-email', () => ({ sendStudioAlertEmail: mockStudioEmail }));
vi.mock('@/server/print-assets/repository', () => ({
  getAssetForFulfilment: mockGetAssetForFulfilment,
}));

const MSG = { orderId: 'ord-1', jobId: 'job-1' };
const ASSET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ASSET_SHA = 'a'.repeat(64);
const PRINT_VARIANT = {
  size: '50x70',
  framed: true,
  mount: false,
  frameColour: 'black',
  prodigiSku: 'GLOBAL-CFP-20X28',
  printAreaPx: { w: 4800, h: 7200 },
  assetId: ASSET_ID,
  assetKey: 'prints/fap01/rev1/4800x7200-abc.jpg',
  assetSha256: ASSET_SHA,
  assetContentType: 'image/jpeg' as const,
  assetWidthPx: 4800,
  assetHeightPx: 7200,
};
const PRINT_ITEMS = [
  { product_id: 'fap01', unit_price: 42000, variant: PRINT_VARIANT },
];
const ENV = {} as CloudflareEnv;
const mockHead = vi.fn().mockResolvedValue({ size: 1234 });
const ENV_SIGNED = {
  PRINT_ASSETS: { head: mockHead } as unknown as R2Bucket,
  PRINT_ASSET_TOKEN_SECRET: 'test-asset-secret',
} as CloudflareEnv;
const CTX = {} as ExecutionContext;

/** Build a thenable chain where every method returns the chain.
 *  Awaiting the chain (or any method's return) resolves to `result`.
 *  `.maybeSingle()` and `.single()` still resolve individually via overrides. */
function makeChain(result: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
    finally: (fn: () => void) => Promise.resolve(result).finally(fn),
  };
  for (const m of ['update', 'eq', 'in', 'select', 'not', 'upsert']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['returns'] = vi.fn().mockResolvedValue(result);
  return { ...chain, ...overrides };
}

function setupMocks({
  claimData = { attempts: 0 } as { attempts: number } | null,
  orderData = null as Record<string, unknown> | null,
  itemsData = [] as unknown[],
} = {}) {
  let jobCallCount = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'fulfilment_jobs') {
      jobCallCount++;
      const claimResult = { data: claimData, error: null };
      const updateResult = { error: null };
      return makeChain(jobCallCount === 1 ? claimResult : updateResult, {
        maybeSingle: vi.fn().mockResolvedValue(claimResult),
      });
    }
    if (table === 'orders') {
      return makeChain({ data: orderData });
    }
    if (table === 'order_items') {
      return makeChain({ data: itemsData });
    }
    if (table === 'prodigi_orders') {
      return makeChain({ error: null });
    }
    return makeChain({ error: null });
  });
}

describe('processJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostOrder.mockResolvedValue({ outcome: 'Created', order: { id: 'pr_order_1', status: { stage: 'InProgress' } } });
    mockGetAssetForFulfilment.mockResolvedValue({
      id: ASSET_ID,
      r2Key: PRINT_VARIANT.assetKey,
      sha256: ASSET_SHA,
      revision: '2026-07-10-r1',
      status: 'ready',
    });
    mockHead.mockResolvedValue({ size: 1234 });
  });

  it('returns early when job is already claimed (duplicate queue delivery)', async () => {
    setupMocks({ claimData: null });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('fulfilment_jobs');
  });

  it('marks job failed_action_required when order is not paid', async () => {
    setupMocks({ orderData: { id: 'ord-1', status: 'pending', shipping_address: null } });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    expect(tables).toContain('orders');
    expect(tables.filter((t: string) => t === 'fulfilment_jobs').length).toBe(2);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ status: 'failed_action_required' });
    expect(mockPostOrder).not.toHaveBeenCalled();
  });

  const PAID_ORDER = {
    id: 'ord-1',
    status: 'paid',
    currency: 'pln',
    email: 'buyer@example.com',
    receiver_first_name: 'Anna',
    receiver_last_name: 'Ciok',
    receiver_phone: null,
    shipping_address: { street: 'Hauptstr.', building_number: '1', city: 'Berlin', post_code: '10115', country_code: 'DE' },
    delivery_method: 'kurier',
  };

  it('happy path: claims, POSTs to Prodigi, persists prodigi_orders, marks fulfilment_submitted', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(mockPostOrder).toHaveBeenCalledTimes(1);
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const poChain = mockFrom.mock.results[tables.lastIndexOf('prodigi_orders')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(poChain['upsert'].mock.calls[0][0]).toMatchObject({
      order_id: 'ord-1',
      prodigi_order_id: 'pr_order_1',
      prodigi_status_stage: 'InProgress',
    });
    const lastJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(lastJobChain['update'].mock.calls[0][0]).toMatchObject({ status: 'fulfilment_submitted', attempts: 1 });
  });

  it('409 duplicate at Prodigi: recovers the existing order id instead of failing the job', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { ProdigiError } = await import('../prodigi/client');
    mockPostOrder.mockRejectedValueOnce(
      // Real signature: (message, status, retryable, body) — body carries the existing order.
      new ProdigiError('Prodigi 409: duplicate', 409, false, { order: { id: 'pr_existing' } }),
    );
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const poChain = mockFrom.mock.results[tables.lastIndexOf('prodigi_orders')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(poChain['upsert'].mock.calls[0][0]).toMatchObject({ prodigi_order_id: 'pr_existing' });
    const lastJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(lastJobChain['update'].mock.calls[0][0]).toMatchObject({ status: 'fulfilment_submitted' });
  });

  it('signs the snapshotted assetId and passes assetId-keyed URLs to buildProdigiPayload', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(vi.mocked(signPrintAssetUrl)).toHaveBeenCalledWith(
      ASSET_ID,
      'test-asset-secret',
      expect.any(Number),
      SITE_URL,
    );
    expect(vi.mocked(buildProdigiPayload)).toHaveBeenCalledTimes(1);
    const assetUrls = vi.mocked(buildProdigiPayload).mock.calls[0][2] as Record<string, string>;
    expect(assetUrls).toEqual({ [ASSET_ID]: 'https://cdn.example.com/asset.jpg' });
  });

  it('marks failed_action_required when R2 binding is absent (no public-image fallback)', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);

    expect(vi.mocked(signPrintAssetUrl)).not.toHaveBeenCalled();
    expect(vi.mocked(buildProdigiPayload)).not.toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('PRINT_ASSETS'),
    });
  });

  it('marks failed_action_required when PRINT_ASSETS is present but PRINT_ASSET_TOKEN_SECRET is absent', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, { PRINT_ASSETS: { head: mockHead } as unknown as R2Bucket } as CloudflareEnv, CTX);

    expect(vi.mocked(signPrintAssetUrl)).not.toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ status: 'failed_action_required' });
  });

  it('marks failed_action_required when the snapshotted asset row is missing', async () => {
    mockGetAssetForFulfilment.mockResolvedValueOnce(null);
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('not found or revoked'),
    });
  });

  it('marks failed_action_required when the R2 object is missing', async () => {
    mockHead.mockResolvedValueOnce(null);
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('R2 object missing'),
    });
  });

  it('marks failed_retryable when getAssetForFulfilment throws a transient DB error', async () => {
    mockGetAssetForFulfilment.mockRejectedValueOnce(new Error('connection reset'));
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    // processJob should re-throw so the queue retries.
    await expect(processJob(MSG, ENV_SIGNED, CTX)).rejects.toThrow('connection reset');

    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_retryable',
      last_error: expect.stringContaining('connection reset'),
    });
  });

  it('marks failed_action_required when snapshot r2_key disagrees with DB record', async () => {
    mockGetAssetForFulfilment.mockResolvedValueOnce({
      id: ASSET_ID,
      r2Key: 'prints/fap01/rev1/DIFFERENT-key.jpg', // mismatch
      sha256: ASSET_SHA,
      revision: '2026-07-10-r1',
      status: 'ready',
    });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(mockPostOrder).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('r2_key mismatch'),
    });
  });

  // ── M-26: Prodigi outcome matrix ─────────────────────────────────────────

  /** Table index helpers: assert prodigi_orders is persisted BEFORE finalization. */
  function tableOrder() {
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    return {
      tables,
      poIdx: tables.lastIndexOf('prodigi_orders'),
      lastJobIdx: tables.lastIndexOf('fulfilment_jobs'),
      lastJobUpdate: () => {
        const chain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
        return chain['update'].mock.calls[0][0] as Record<string, unknown>;
      },
      poUpsert: () => {
        const chain = mockFrom.mock.results[tables.lastIndexOf('prodigi_orders')].value as Record<string, ReturnType<typeof vi.fn>>;
        return chain['upsert'].mock.calls[0][0] as Record<string, unknown>;
      },
    };
  }

  it('outcome Created: submitted, prodigi_orders written, NO alert', async () => {
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    const o = tableOrder();
    expect(o.poUpsert()).toMatchObject({ prodigi_order_id: 'pr_order_1' });
    expect(o.lastJobUpdate()).toMatchObject({ status: 'fulfilment_submitted' });
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(mockStudioEmail).not.toHaveBeenCalled();
  });

  it('outcome alreadyExists (docs camelCase): submitted, no alert — casing-insensitive', async () => {
    mockPostOrder.mockResolvedValueOnce({ outcome: 'alreadyExists', order: { id: 'pr_order_1', status: { stage: 'InProgress' } } });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    expect(tableOrder().lastJobUpdate()).toMatchObject({ status: 'fulfilment_submitted' });
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    expect(mockStudioEmail).not.toHaveBeenCalled();
  });

  it('outcome CreatedWithIssues: prodigi_orders BEFORE finalization, submitted + untruncated issues + loud alert, no throw', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longDescription = 'asset colour profile mismatch — '.repeat(20); // ~640 chars, must survive whole
    mockPostOrder.mockResolvedValueOnce({
      outcome: 'CreatedWithIssues',
      order: {
        id: 'pr_issues_1',
        status: {
          stage: 'InProgress',
          issues: [{ objectId: 'item-1', errorCode: 'items.assets.NotDownloaded', description: longDescription }],
        },
      },
    });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await expect(processJob(MSG, ENV_SIGNED, CTX)).resolves.toBeUndefined(); // no throw → no retry-create

    const o = tableOrder();
    expect(o.poIdx).toBeGreaterThan(-1);
    expect(o.poIdx).toBeLessThan(o.lastJobIdx); // remote order persisted before status finalization
    expect(o.poUpsert()).toMatchObject({ prodigi_order_id: 'pr_issues_1' });
    const update = o.lastJobUpdate();
    expect(update).toMatchObject({ status: 'fulfilment_submitted' });
    expect(String(update.last_error)).toContain('items.assets.NotDownloaded');
    expect(String(update.last_error)).toContain(longDescription); // no silent truncation
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    expect(mockCaptureAlert.mock.calls[0][1]).toMatchObject({ message: 'prodigi_order_outcome_issues', level: 'error' });
    expect(mockStudioEmail).toHaveBeenCalledTimes(1);
    expect(mockPostOrder).toHaveBeenCalledTimes(1); // never re-POSTed
    consoleErrorSpy.mockRestore();
  });

  it('outcome OnHold: prodigi_orders written, failed_action_required with reason (cron sweep alerts it)', async () => {
    mockPostOrder.mockResolvedValueOnce({
      outcome: 'OnHold',
      order: { id: 'pr_hold_1', status: { stage: 'InProgress', issues: [] } },
    });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await expect(processJob(MSG, ENV_SIGNED, CTX)).resolves.toBeUndefined();

    const o = tableOrder();
    expect(o.poUpsert()).toMatchObject({ prodigi_order_id: 'pr_hold_1' });
    expect(o.poIdx).toBeLessThan(o.lastJobIdx);
    const update = o.lastJobUpdate();
    expect(update).toMatchObject({ status: 'failed_action_required' });
    expect(String(update.last_error)).toContain('OnHold');
  });

  it('unknown outcome: treated as CreatedWithIssues (submitted + alert), never as silent success', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPostOrder.mockResolvedValueOnce({
      outcome: 'SomeFutureOutcome',
      order: { id: 'pr_future_1', status: { stage: 'InProgress' } },
    });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV_SIGNED, CTX);

    const update = tableOrder().lastJobUpdate();
    expect(update).toMatchObject({ status: 'fulfilment_submitted' });
    expect(String(update.last_error)).toContain('somefutureoutcome');
    expect(mockCaptureAlert).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('a studio-email failure on the issues path is swallowed (never a retry-create)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStudioEmail.mockRejectedValueOnce(new Error('resend down'));
    mockPostOrder.mockResolvedValueOnce({
      outcome: 'CreatedWithIssues',
      order: { id: 'pr_issues_2', status: { stage: 'InProgress', issues: [] } },
    });
    setupMocks({ orderData: PAID_ORDER, itemsData: PRINT_ITEMS });
    const { processJob } = await import('./process-job');

    await expect(processJob(MSG, ENV_SIGNED, CTX)).resolves.toBeUndefined();
    consoleErrorSpy.mockRestore();
  });

  it('marks job failed_action_required when shipping address is missing', async () => {
    setupMocks({ orderData: { id: 'ord-1', status: 'paid', shipping_address: null } });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    const tables = mockFrom.mock.calls.map(([t]: string[]) => t);
    expect(tables.filter((t: string) => t === 'fulfilment_jobs').length).toBe(2);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('shipping address'),
    });
  });
});
