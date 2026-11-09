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
      gclid: null,
      gbraid: null,
      wbraid: null,
    });
  });

  it('reads gclid from _gcl_aw and gbraid from _gcl_gb', () => {
    const { doc, loc, nowMs } = fakeEnv('_gcl_aw=GCL.1700000000.Cj0KCQjw_abc-123; _gcl_gb=GCL.1700000001.AAAgbraid-xyz9');
    const out = collectMarketingCookies(doc, loc, nowMs);
    expect(out.gclid).toBe('Cj0KCQjw_abc-123');
    expect(out.gbraid).toBe('AAAgbraid-xyz9');
  });

  it('falls back to gclid/gbraid/wbraid URL params when the cookies are absent', () => {
    const { doc, loc, nowMs } = fakeEnv('', '?gclid=Cj0KCQjw_url-123&gbraid=AAAgbraid-url9&wbraid=BBBwbraid-url9');
    const out = collectMarketingCookies(doc, loc, nowMs);
    expect(out).toMatchObject({ gclid: 'Cj0KCQjw_url-123', gbraid: 'AAAgbraid-url9', wbraid: 'BBBwbraid-url9' });
  });

  it('prefers the cookie over the URL param and ignores malformed values', () => {
    const { doc, loc, nowMs } = fakeEnv('_gcl_aw=GCL.1700000000.CookieClickId99', '?gclid=UrlClickId9999&wbraid=%3Cscript%3E');
    const out = collectMarketingCookies(doc, loc, nowMs);
    expect(out.gclid).toBe('CookieClickId99');
    expect(out.wbraid).toBeNull();
    expect(collectMarketingCookies(fakeEnv('_gcl_aw=garbage').doc, fakeEnv('').loc, nowMs).gclid).toBeNull();
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
      gclid: null,
      gbraid: null,
      wbraid: null,
    });
  });
});
