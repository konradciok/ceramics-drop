import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTerminalStatus, mapProdigiStage } from './status-map';

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

const { mockFrom, mockPostOrder } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockPostOrder: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('../prodigi/client', () => ({
  prodigiClient: vi.fn(() => ({ postOrder: mockPostOrder })),
  ProdigiError: class ProdigiError extends Error { status: number; body: unknown; retryable: boolean;
    constructor(m: string, s: number, b: unknown, r: boolean) { super(m); this.status = s; this.body = b; this.retryable = r; }
  },
}));
vi.mock('../prodigi/mapper', () => ({ buildProdigiPayload: vi.fn(() => ({})) }));
vi.mock('@/lib/print-assets', () => ({ signPrintAssetUrl: vi.fn().mockResolvedValue('https://cdn.example.com/asset.jpg') }));
vi.mock('@/lib/prints', () => ({ getPrintById: vi.fn().mockReturnValue({ image: '/uploads/fap-01.webp' }) }));
vi.mock('@/lib/site', () => ({ SITE_URL: 'https://anna-ciok.studio' }));

const MSG = { orderId: 'ord-1', jobId: 'job-1' };
const ENV = {} as CloudflareEnv; // no PRINT_ASSETS → falls back to public URL
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
      // First call is the atomic claim (ends in .maybeSingle()).
      // Subsequent calls are failJob/success updates (awaited at .eq() level).
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
    mockPostOrder.mockResolvedValue({ order: { id: 'pr_order_1' } });
  });

  it('returns early when job is already claimed (duplicate queue delivery)', async () => {
    setupMocks({ claimData: null }); // conditional UPDATE matched no rows
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    // Only one from() call — the claim attempt. Orders are never loaded.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('fulfilment_jobs');
  });

  it('marks job failed_action_required when order is not paid', async () => {
    setupMocks({ orderData: { id: 'ord-1', status: 'pending', shipping_address: null } });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    // Expect a second fulfilment_jobs call (the failJob update)
    const tables = mockFrom.mock.calls.map(([t]: [string]) => t);
    expect(tables).toContain('orders');
    expect(tables.filter((t: string) => t === 'fulfilment_jobs').length).toBe(2);
    // The second fulfilment_jobs call's update arg should be failed_action_required
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ status: 'failed_action_required' });
  });

  it('marks job failed_action_required when shipping address is missing', async () => {
    setupMocks({ orderData: { id: 'ord-1', status: 'paid', shipping_address: null } });
    const { processJob } = await import('./process-job');
    await processJob(MSG, ENV, CTX);
    const tables = mockFrom.mock.calls.map(([t]: [string]) => t);
    expect(tables.filter((t: string) => t === 'fulfilment_jobs').length).toBe(2);
    const secondJobChain = mockFrom.mock.results[tables.lastIndexOf('fulfilment_jobs')].value as Record<string, ReturnType<typeof vi.fn>>;
    expect((secondJobChain['update'] as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed_action_required',
      last_error: expect.stringContaining('shipping address'),
    });
  });
});
