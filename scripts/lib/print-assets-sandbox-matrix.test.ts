import { describe, it, expect, vi } from 'vitest';
import {
  parseSandboxArgs,
  defaultRunId,
  classifyCreateOutcome,
  summarizeCreateResponse,
  postSandboxOrder,
} from './print-assets-sandbox-matrix';

describe('parseSandboxArgs', () => {
  it('defaults to product fap01, no run-id, dryRun/help false', () => {
    expect(parseSandboxArgs([])).toEqual({ product: 'fap01', runId: undefined, dryRun: false, help: false });
  });

  it('parses explicit --product, --run-id, --dry-run, and --help', () => {
    expect(parseSandboxArgs(['--product', 'fap02', '--run-id', '2026-07-13-r2', '--dry-run', '--help'])).toEqual({
      product: 'fap02',
      runId: '2026-07-13-r2',
      dryRun: true,
      help: true,
    });
  });

  it('rejects an empty --env-file value', () => {
    expect(() => parseSandboxArgs(['--env-file='])).toThrow(/non-empty/i);
  });

  it('rejects --env-file supplied more than once', () => {
    expect(() => parseSandboxArgs(['--env-file', 'a', '--env-file', 'b'])).toThrow(/once/i);
  });

  it('rejects an unrecognised flag (typo)', () => {
    expect(() => parseSandboxArgs(['--dryrun'])).toThrow(/Unknown option/i);
  });

  it('rejects an empty --run-id value', () => {
    expect(() => parseSandboxArgs(['--run-id='])).toThrow(/run-id/i);
  });

  it('rejects an empty --product value', () => {
    expect(() => parseSandboxArgs(['--product='])).toThrow(/product/i);
  });
});

describe('defaultRunId', () => {
  it('formats UTC date + time (ms precision) + injected uuid deterministically', () => {
    expect(defaultRunId(new Date('2026-07-21T12:34:56.789Z'), () => 'uuid-1')).toBe(
      '2026-07-21-123456789-uuid-1',
    );
  });

  it('is unique per call by default (real Date.now + crypto.randomUUID)', () => {
    expect(defaultRunId()).toMatch(
      /^\d{4}-\d{2}-\d{2}-\d{9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(defaultRunId()).not.toBe(defaultRunId());
  });
});

describe('classifyCreateOutcome', () => {
  it('treats created/onHold as success', () => {
    expect(classifyCreateOutcome({ outcome: 'created' })).toBe('success');
    expect(classifyCreateOutcome({ outcome: 'onHold' })).toBe('success');
  });

  it('treats alreadyExists as duplicate', () => {
    expect(classifyCreateOutcome({ outcome: 'alreadyExists' })).toBe('duplicate');
  });

  it('treats createdWithIssues as failure', () => {
    expect(classifyCreateOutcome({ outcome: 'createdWithIssues' })).toBe('failure');
  });

  it('is case-insensitive on initial-capital Prodigi casings', () => {
    expect(classifyCreateOutcome({ outcome: 'Created' })).toBe('success');
    expect(classifyCreateOutcome({ outcome: 'AlreadyExists' })).toBe('duplicate');
    expect(classifyCreateOutcome({ outcome: 'CreatedWithIssues' })).toBe('failure');
  });

  it('throws on an unrecognised outcome', () => {
    expect(() => classifyCreateOutcome({ outcome: 'unexpected' })).toThrow(/Unexpected Prodigi outcome/);
  });

  it('throws when outcome is missing or the body is not an object', () => {
    expect(() => classifyCreateOutcome({})).toThrow(/Unexpected Prodigi outcome/);
    expect(() => classifyCreateOutcome(null)).toThrow(/Unexpected Prodigi outcome/);
  });
});

describe('summarizeCreateResponse', () => {
  it('extracts outcome/orderId/stage/issues from a well-formed response', () => {
    const body = {
      outcome: 'createdWithIssues',
      order: { id: 'ord_1', status: { stage: 'InProgress', issues: [{ code: 'W1' }] } },
    };
    expect(summarizeCreateResponse(body)).toEqual({
      outcome: 'createdWithIssues',
      orderId: 'ord_1',
      stage: 'InProgress',
      issues: [{ code: 'W1' }],
    });
  });

  it('defaults missing/malformed fields to null/empty', () => {
    expect(summarizeCreateResponse({})).toEqual({ outcome: null, orderId: null, stage: null, issues: [] });
    expect(summarizeCreateResponse(null)).toEqual({ outcome: null, orderId: null, stage: null, issues: [] });
  });

  it('never surfaces asset/signed-URL data even when the raw response echoes it back', () => {
    const body = {
      outcome: 'created',
      order: {
        id: 'ord_2',
        status: { stage: 'Complete', issues: [] },
        items: [{ assets: [{ printArea: 'default', url: 'https://signed.example/print-assets/abc?sig=deadbeef' }] }],
      },
    };
    const summary = summarizeCreateResponse(body);
    expect(summary).toEqual({ outcome: 'created', orderId: 'ord_2', stage: 'Complete', issues: [] });
    expect(Object.keys(summary)).toEqual(['outcome', 'orderId', 'stage', 'issues']);
    expect(JSON.stringify(summary)).not.toMatch(/assets|signed\.example|sig=/i);
  });

  it('redacts sig values inside issue strings (asset-download issues echo the failing signed URL)', () => {
    const body = {
      outcome: 'createdWithIssues',
      order: {
        id: 'ord_3',
        status: {
          stage: 'InProgress',
          issues: [
            {
              errorCode: 'items.assets.NotDownloaded',
              description:
                'Asset could not be downloaded from https://anna-ciok.studio/api/print-assets/abc?exp=1753000000&sig=deadbeefcafe1234',
              nested: { url: 'https://anna-ciok.studio/api/print-assets/abc?sig=DEADBEEF' },
              nonHex: { url: 'https://anna-ciok.studio/api/print-assets/abc?sig=QmFzZTY0-_url~safe' },
            },
          ],
        },
      },
    };
    const serialized = JSON.stringify(summarizeCreateResponse(body));
    expect(serialized).not.toMatch(/sig=deadbeefcafe1234|sig=DEADBEEF|sig=QmFzZTY0/);
    expect(serialized).toContain('sig=[redacted]');
    expect(serialized).toContain('items.assets.NotDownloaded');
  });
});

describe('postSandboxOrder', () => {
  function fakeFetch(body: unknown, status: number) {
    const calls: Array<{ url: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    });
    return { impl, calls };
  }

  it('classifies HTTP 200 created as success', async () => {
    const { impl } = fakeFetch(
      { outcome: 'created', order: { id: 'ord_1', status: { stage: 'InProgress', issues: [] } } },
      200,
    );
    const result = await postSandboxOrder({ apiKey: 'key', payload: {}, fetchImpl: impl });
    expect(result.classification).toBe('success');
    expect(result.summary.orderId).toBe('ord_1');
  });

  /** The CLI's duplicate/failure result entry: row context + sanitized summary. */
  const rowContext = {
    profileKey: '3600x4800',
    variantKey: 'fap01:30x40:framed',
    sku: 'GLOBAL-FAP-30X40',
    assetId: 'asset-uuid',
    idempotencyKey: 'fap01-sandbox-matrix-run-3600x4800',
  };

  it('classifies HTTP 200 alreadyExists (either casing) as duplicate, not success; result entry keeps row context without assets/URLs', async () => {
    for (const outcome of ['alreadyExists', 'AlreadyExists']) {
      const { impl } = fakeFetch(
        {
          outcome,
          order: {
            id: 'ord_dup',
            status: { stage: 'Complete', issues: [] },
            items: [{ assets: [{ printArea: 'default', url: 'https://signed.example/print-assets/abc?sig=deadbeef' }] }],
          },
        },
        200,
      );
      const result = await postSandboxOrder({ apiKey: 'key', payload: {}, fetchImpl: impl });
      expect(result.classification).toBe('duplicate');
      const entry = { ...rowContext, ...result.summary };
      expect(entry).toMatchObject({ ...rowContext, outcome, orderId: 'ord_dup' });
      expect(Object.keys(entry).sort()).toEqual(
        ['profileKey', 'variantKey', 'sku', 'assetId', 'idempotencyKey', 'outcome', 'orderId', 'stage', 'issues'].sort(),
      );
      expect(JSON.stringify(entry)).not.toMatch(/assets|signed\.example|sig=/i);
    }
  });

  it('classifies HTTP 200 createdWithIssues (either casing) as failure and records order id + status issues alongside row context', async () => {
    for (const outcome of ['createdWithIssues', 'CreatedWithIssues']) {
      const issues = [{ code: 'ArtworkLowRes' }];
      const { impl } = fakeFetch(
        {
          outcome,
          order: {
            id: 'ord_issues',
            status: { stage: 'InProgress', issues },
            items: [{ assets: [{ printArea: 'default', url: 'https://signed.example/print-assets/abc?sig=deadbeef' }] }],
          },
        },
        200,
      );
      const result = await postSandboxOrder({ apiKey: 'key', payload: {}, fetchImpl: impl });
      expect(result.classification).toBe('failure');
      expect(result.summary.orderId).toBe('ord_issues');
      expect(result.summary.issues).toEqual(issues);
      const entry = { ...rowContext, ...result.summary };
      expect(entry).toMatchObject({ ...rowContext, orderId: 'ord_issues', issues });
      expect(JSON.stringify(entry)).not.toMatch(/assets|signed\.example|sig=/i);
    }
  });

  it('throws a sanitized error on a non-2xx response without leaking assets/signed URLs', async () => {
    const signedUrl = 'https://signed.example/print-assets/abc?sig=deadbeef';
    const { impl } = fakeFetch(
      {
        outcome: 'created',
        order: {
          id: 'ord_err',
          status: { stage: 'Failed', issues: [] },
          items: [{ assets: [{ printArea: 'default', url: signedUrl }] }],
        },
      },
      500,
    );
    let caught: unknown;
    try {
      await postSandboxOrder({ apiKey: 'key', payload: { items: [{ assets: [{ url: signedUrl }] }] }, fetchImpl: impl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/Prodigi order failed \(500\)/);
    expect(message).not.toMatch(/signed\.example|sig=deadbeef/);
  });

  it('bounds the request with an AbortSignal (timeout ownership lives here, not the CLI)', async () => {
    const { impl, calls } = fakeFetch(
      { outcome: 'created', order: { id: 'ord_1', status: { stage: 'InProgress', issues: [] } } },
      200,
    );
    await postSandboxOrder({ apiKey: 'key', payload: {}, fetchImpl: impl });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
