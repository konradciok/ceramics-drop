import { describe, it, expect } from 'vitest';
import { collectMarketingCookies } from './client-cookies';

function fakeEnv(cookie: string, search = '') {
  return {
    doc: { cookie } as Document,
    loc: { search } as Location,
    nowMs: 1_680_000_000_000,
  };
}

describe('collectMarketingCookies', () => {
  it('reads _fbp, _fbc, _ga, and a _ga_<id> cookie', () => {
    const { doc, loc, nowMs } = fakeEnv(
      '_fbp=fb.1.1.AAA; _fbc=fb.1.2.BBB; _ga=GA1.1.111.222; _ga_ABC123=GS1.1.999.1',
    );
    expect(collectMarketingCookies(doc, loc, nowMs)).toEqual({
      fbp: 'fb.1.1.AAA',
      fbc: 'fb.1.2.BBB',
      ga_client_id: '111.222',
      ga_session_id: '999',
    });
  });

  it('derives _fbc from an fbclid query param when the cookie is absent', () => {
    const { doc, loc, nowMs } = fakeEnv('_ga=GA1.1.111.222', '?fbclid=XYZ');
    const out = collectMarketingCookies(doc, loc, nowMs);
    expect(out.fbc).toBe('fb.1.1680000000000.XYZ');
  });

  it('returns nulls when nothing is present', () => {
    const { doc, loc, nowMs } = fakeEnv('');
    expect(collectMarketingCookies(doc, loc, nowMs)).toEqual({
      fbp: null,
      fbc: null,
      ga_client_id: null,
      ga_session_id: null,
    });
  });
});
