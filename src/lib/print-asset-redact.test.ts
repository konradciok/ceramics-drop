import { describe, it, expect } from 'vitest';
import { deepRedactSignedUrls, redactSignedPrintAssetUrl } from './print-asset-redact';

const SIGNED =
  'https://anna-ciok.studio/api/print-assets/asset-1?exp=1770000000&sig=' + 'a'.repeat(64);

describe('redactSignedPrintAssetUrl', () => {
  it('masks sig but keeps the path and exp', () => {
    const out = redactSignedPrintAssetUrl(SIGNED);
    expect(out).toContain('/api/print-assets/asset-1');
    expect(out).toContain('exp=1770000000');
    expect(out).toContain('sig=%5BREDACTED%5D');
    expect(out).not.toContain('a'.repeat(64));
  });

  it('masks a token param too', () => {
    const out = redactSignedPrintAssetUrl('https://x.example/p?token=secret123&exp=1');
    expect(out).not.toContain('secret123');
    expect(out).toContain('exp=1');
  });
});

describe('deepRedactSignedUrls', () => {
  it('redacts the v4 items[].assets[].url shape while keeping exp and everything else', () => {
    const order = {
      id: 'ord_1',
      status: { stage: 'InProgress' },
      items: [
        {
          id: 'item-1',
          assets: [{ printArea: 'default', url: SIGNED, md5Hash: 'deadbeef' }],
        },
      ],
    };

    const out = deepRedactSignedUrls(order);
    const url = out.items[0].assets[0].url;
    expect(url).toContain('exp=1770000000');
    expect(url).not.toContain('a'.repeat(64));
    expect(out.items[0].assets[0].md5Hash).toBe('deadbeef');
    expect(out.status.stage).toBe('InProgress');
    // Input is not mutated.
    expect(order.items[0].assets[0].url).toBe(SIGNED);
  });

  it('redacts signed URLs anywhere in the tree, not only the documented path', () => {
    const body = { data: { somethingNew: { deep: [SIGNED] } } };
    const out = deepRedactSignedUrls(body);
    expect(JSON.stringify(out)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(out)).toContain('exp=1770000000');
  });

  it('passes through non-URL strings, numbers, null and booleans unchanged', () => {
    const value = { a: 'plain text', b: 42, c: null, d: true, e: 'design=nice' };
    expect(deepRedactSignedUrls(value)).toEqual(value);
  });

  it('leaves an unparseable sig-bearing string as-is instead of throwing', () => {
    expect(deepRedactSignedUrls('sig=abc but not a URL')).toBe('sig=abc but not a URL');
  });
});
