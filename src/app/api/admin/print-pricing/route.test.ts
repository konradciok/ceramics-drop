import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import { POST } from './route';

// CmsApi pricing cutover, plan step 8: this route no longer writes
// print_pricing_config directly. It calls save_pricing_draft then
// publish_pricing_revision (the same RPCs PUT /v1/pricing/{id} and POST
// /v1/pricing/{id}/publication use), then re-reads the live row. These tests
// assert that repointing, plus that the route's wire contract — nested
// PrintPricingConfig in, {config} out, same error strings — did not change.
const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));

const ROW = {
  id: true,
  base_30x40_eur: 25, base_50x70_eur: 50, base_70x100_eur: 75,
  frame_30x40_eur: 35, frame_50x70_eur: 35, frame_70x100_eur: 35,
  mount_30x40_eur: 25, mount_50x70_eur: 25, mount_70x100_eur: 25,
  eur_to_pln: 4.25, eur_to_gbp: 0.86,
  published_revision: 7,
  updated_at: '2026-08-07T00:00:00Z', updated_by: null,
};

/**
 * A Supabase double covering the repointed path: the latest-draft revision
 * lookup (select→order→limit→maybeSingle), the two rpc() calls, and the
 * post-publish re-read of print_pricing_config (select→abortSignal→maybeSingle).
 */
function supabase(
  opts: {
    latestRevision?: number | null;
    after?: unknown;
    saveError?: { message: string; details?: string };
    publishError?: { message: string; details?: string };
  } = {},
) {
  const {
    latestRevision = 7,
    after = { ...ROW, base_50x70_eur: 60, published_revision: 8 },
    saveError,
    publishError,
  } = opts;

  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'save_pricing_draft') return { data: null, error: saveError ?? null };
    if (fn === 'publish_pricing_revision') return { data: null, error: publishError ?? null };
    throw new Error(`route.test.ts: unmocked rpc "${fn}"`);
  });

  const from = vi.fn((table: string) => {
    const data = table === 'pricing_config_drafts' ? (latestRevision === null ? null : { revision: latestRevision }) : after;
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      abortSignal: () => builder,
      maybeSingle: () => Promise.resolve({ data, error: null }),
    };
    return builder;
  });

  return { supabase: { from, rpc }, rpc };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/print-pricing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = { ...DEFAULT_PRINT_PRICING, baseEur: { ...DEFAULT_PRINT_PRICING.baseEur, '50x70': 60 } };

describe('POST /api/admin/print-pricing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves a draft and publishes it through the CmsApi RPCs → 200', async () => {
    const { supabase: sb, rpc } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req(VALID, { 'X-Admin-Actor-Email': 'anna@studio.pl' }));

    expect(res.status).toBe(200);
    expect((await res.json()).config.baseEur['50x70']).toBe(60);

    expect(rpc).toHaveBeenNthCalledWith(1, 'save_pricing_draft', {
      p_expected_revision: 7,
      p_payload: {
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'base_50x70_eur', value: '60', type: 'number', locale: 'none' }),
        ]),
      },
      p_actor_email: 'anna@studio.pl',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'publish_pricing_revision', {
      p_expected_revision: 8,
      p_actor_email: 'anna@studio.pl',
    });
  });

  it('sends all 11 pricing fields in the draft payload', async () => {
    const { supabase: sb, rpc } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);
    await POST(req(VALID));
    const calls = rpc.mock.calls as unknown as [string, { p_payload: { fields: { key: string }[] } }][];
    expect(calls[0][1].p_payload.fields).toHaveLength(11);
  });

  it('starts from revision 0 when no draft exists yet', async () => {
    const { supabase: sb, rpc } = supabase({ latestRevision: null });
    mocks.adminSupabase.mockReturnValue(sb);
    await POST(req(VALID));
    expect(rpc).toHaveBeenNthCalledWith(1, 'save_pricing_draft', expect.objectContaining({ p_expected_revision: 0 }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'publish_pricing_revision', expect.objectContaining({ p_expected_revision: 1 }));
  });

  it.each([
    ['negative surcharge', { ...VALID, frameEur: { ...VALID.frameEur, '30x40': -1 } }],
    ['fractional price', { ...VALID, baseEur: { ...VALID.baseEur, '30x40': 24.5 } }],
    ['zero base', { ...VALID, baseEur: { ...VALID.baseEur, '70x100': 0 } }],
    ['zero rate', { ...VALID, eurToPln: 0 }],
    ['unknown key (strict)', { ...VALID, extra: 1 }],
    ['NaN from an empty form field', { ...VALID, eurToGbp: null }],
  ])('rejects %s → 400 validation_failed with field errors, before touching the DB', async (_name, body) => {
    mocks.adminSupabase.mockReturnValue(supabase().supabase);
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
    expect(json.fields).toBeDefined();
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('missing seed row (migration not applied) → 404 print_pricing_missing', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ saveError: { message: 'pricing_config_missing' } }).supabase);
    const res = await POST(req(VALID));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('print_pricing_missing');
  });

  it('a concurrent CMS save → 409 pricing_revision_conflict, and no publish is attempted', async () => {
    const { supabase: sb, rpc } = supabase({ saveError: { message: 'revision_conflict', details: 'currentRevision=9' } });
    mocks.adminSupabase.mockReturnValue(sb);
    const res = await POST(req(VALID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('pricing_revision_conflict');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('DB failure → 500 pricing_write_failed without leaking detail', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ publishError: { message: 'connection reset' } }).supabase);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req(VALID));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pricing_write_failed');
    errSpy.mockRestore();
  });
});
