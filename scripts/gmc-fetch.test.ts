import { describe, expect, it } from 'vitest';
import { parseArgs, selectFetchSources } from './gmc-fetch.mjs';

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
