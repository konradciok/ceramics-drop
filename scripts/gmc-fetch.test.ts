import { describe, expect, it } from 'vitest';
import { listAllDataSources, parseArgs, selectFetchSources, triggerFetches } from './gmc-fetch.mjs';

describe('gmc-fetch parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toMatchObject({ confirm: false, only: null, account: null, keyFile: null });
  });
  it('accepts --confirm, --only, --account and --key-file in both forms', () => {
    expect(parseArgs(['--confirm', '--only', '123', '--account=456', '--key-file', '/k.json'])).toMatchObject({
      confirm: true, only: '123', account: '456', keyFile: '/k.json',
    });
  });
  it('rejects unknown flags, missing values and non-numeric ids', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--only'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--only', 'abc'])).toThrow(/numeric/);
    expect(() => parseArgs(['--account=x'])).toThrow(/numeric/);
  });
});

describe('gmc-fetch selectFetchSources', () => {
  const fetchSource = (id: string) => ({ dataSourceId: id, input: 'FILE', fileInput: { fileInputType: 'FETCH' } });
  const sources = [
    fetchSource('1'),
    fetchSource('2'),
    { dataSourceId: '3', input: 'API' },
    { dataSourceId: '4', input: 'FILE', fileInput: { fileInputType: 'UPLOAD' } },
  ];
  it('keeps only scheduled-fetch FILE sources', () => {
    expect(selectFetchSources(sources).map((s) => s.dataSourceId)).toEqual(['1', '2']);
  });
  it('narrows to one id, and returns nothing for a non-fetchable one', () => {
    expect(selectFetchSources(sources, '2').map((s) => s.dataSourceId)).toEqual(['2']);
    expect(selectFetchSources(sources, '3')).toEqual([]);
  });
});

describe('gmc-fetch listAllDataSources', () => {
  it('follows nextPageToken until the last page', async () => {
    const pages: Record<string, { dataSources: unknown[]; nextPageToken?: string }> = {
      '': { dataSources: [{ dataSourceId: '1' }], nextPageToken: 'p2' },
      p2: { dataSources: [{ dataSourceId: '2' }], nextPageToken: 'p3' },
      p3: { dataSources: [{ dataSourceId: '3' }] },
    };
    const urls: string[] = [];
    const request = async ({ url }: { url: string }) => {
      urls.push(url);
      return { data: pages[new URL(url).searchParams.get('pageToken') ?? ''] };
    };
    const all = await listAllDataSources(request, '42');
    expect(all.map((d: { dataSourceId: string }) => d.dataSourceId)).toEqual(['1', '2', '3']);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('/accounts/42/dataSources');
  });

  it('tolerates an empty account and refuses a repeated page token', async () => {
    await expect(listAllDataSources(async () => ({ data: {} }), '42')).resolves.toEqual([]);
    const loop = async () => ({ data: { dataSources: [], nextPageToken: 'same' } });
    await expect(listAllDataSources(loop, '42')).rejects.toThrow(/repeated nextPageToken/);
  });
});

describe('gmc-fetch triggerFetches', () => {
  const sources = [
    { dataSourceId: '1', name: 'accounts/42/dataSources/1' },
    { dataSourceId: '2', name: 'accounts/42/dataSources/2' },
    { dataSourceId: '3', name: 'accounts/42/dataSources/3' },
  ];

  it('POSTs :fetch for each source and reports success', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const results = await triggerFetches(async (req: Record<string, unknown>) => {
      calls.push({ url: String(req.url), method: String(req.method) });
      return { status: 200, data: {} };
    }, sources);
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true]);
    expect(calls.every((c) => c.method === 'POST' && c.url.endsWith(':fetch'))).toBe(true);
  });

  it('keeps going after a rejected request or an HTTP error, and records each failure', async () => {
    let n = 0;
    const results = await triggerFetches(async () => {
      n += 1;
      if (n === 1) throw new Error('socket hang up');
      if (n === 2) return { status: 403, data: { error: { message: 'denied' } } };
      return { status: 200, data: {} };
    }, sources);
    expect(n).toBe(3); // the third source still got its request
    expect(results[0]).toMatchObject({ id: '1', ok: false, status: null, message: 'socket hang up' });
    expect(results[1]).toMatchObject({ id: '2', ok: false, status: 403 });
    expect(results[2]).toMatchObject({ id: '3', ok: true, status: 200 });
  });
});
