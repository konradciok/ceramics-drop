import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  defaultConsentSnippet,
  COOKIE_NAME,
  CONSENT_CHANGE_EVENT,
  CONSENT_OPEN_EVENT,
  choiceEffect,
  cookieDomains,
  isBannerVisible,
  openConsentSettings,
  readConsent,
  setConsent,
  trackingCookieNames,
} from './consent-mode';

describe('consent mode', () => {
  it('default snippet denies analytics/ad storage', () => {
    const s = defaultConsentSnippet();
    expect(s).toContain("'analytics_storage': 'denied'");
    expect(s).toContain("'ad_storage': 'denied'");
  });
  it('restores stored granted consent (update before GTM) for returning visitors', () => {
    const s = defaultConsentSnippet();
    expect(s).toContain("'consent', 'update'");
    expect(s).toContain(COOKIE_NAME);
    expect(s).toContain("'analytics_storage': 'granted'");
  });
  it('reads stored consent from cookie string', () => {
    expect(readConsent(`${COOKIE_NAME}=granted`)).toBe('granted');
    expect(readConsent(`foo=1; ${COOKIE_NAME}=granted`)).toBe('granted');
    expect(readConsent(`foo=1;${COOKIE_NAME}=denied`)).toBe('denied'); // no space after ';'
    expect(readConsent('')).toBe(null);
  });
});

describe('setConsent', () => {
  function stubWindowAndDocument() {
    const gtagCalls: unknown[][] = [];
    const dispatchedEvents: Event[] = [];
    const cookieStore = { cookie: '' };
    vi.stubGlobal('document', cookieStore);
    vi.stubGlobal('window', {
      dataLayer: [],
      gtag: (...args: unknown[]) => { gtagCalls.push(args); },
      dispatchEvent: (event: Event) => { dispatchedEvents.push(event); return true; },
    });
    return { gtagCalls, cookieStore, dispatchedEvents };
  }

  it('granted: writes the cookie, updates gtag consent, and pushes consent_update', () => {
    const { gtagCalls, cookieStore, dispatchedEvents } = stubWindowAndDocument();

    setConsent('granted');

    expect(cookieStore.cookie).toContain(`${COOKIE_NAME}=granted`);
    expect(gtagCalls).toEqual([
      ['consent', 'update', {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        analytics_storage: 'granted',
      }],
    ]);
    expect(window.dataLayer).toEqual([
      { event: 'consent_update', consent_state: 'granted' },
    ]);
    // useGooglePlacesLoader (and any future same-page-view consumer) listens
    // for this to react to a consent change without a reload.
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0]?.type).toBe(CONSENT_CHANGE_EVENT);
    expect((dispatchedEvents[0] as CustomEvent).detail).toEqual({ value: 'granted' });
  });

  it('denied: writes the cookie, updates gtag consent, and pushes consent_update', () => {
    const { gtagCalls, cookieStore, dispatchedEvents } = stubWindowAndDocument();

    setConsent('denied');

    expect(cookieStore.cookie).toContain(`${COOKIE_NAME}=denied`);
    expect(gtagCalls).toEqual([
      ['consent', 'update', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      }],
    ]);
    expect(window.dataLayer).toEqual([
      { event: 'consent_update', consent_state: 'denied' },
    ]);
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0]?.type).toBe(CONSENT_CHANGE_EVENT);
    expect((dispatchedEvents[0] as CustomEvent).detail).toEqual({ value: 'denied' });
  });
});

/**
 * Minimal cookie jar: a cookie is keyed by name + domain attribute (undefined
 * = host-only), and a `max-age=0` write only removes the entry whose domain
 * attribute matches — as in a browser.
 */
function cookieJar(initial: Array<{ name: string; value: string; domain?: string }>) {
  const entries = new Map<string, { name: string; value: string; domain?: string }>();
  const key = (name: string, domain?: string) => `${name}|${domain ?? ''}`;
  for (const c of initial) entries.set(key(c.name, c.domain), c);
  return {
    entries,
    get cookie() {
      return [...entries.values()].map((c) => `${c.name}=${c.value}`).join('; ');
    },
    set cookie(write: string) {
      const [pair, ...attrs] = write.split(/;\s*/);
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      const domain = attrs.find((a) => a.startsWith('domain='))?.slice('domain='.length).replace(/^\./, '');
      if (attrs.includes('max-age=0')) entries.delete(key(name, domain));
      else entries.set(key(name, domain), { name, value, domain });
    },
  };
}

describe('reopening the banner ("Cookie settings")', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('openConsentSettings dispatches the open event the banner listens for', () => {
    const events: Event[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => { events.push(e); return true; } });
    openConsentSettings();
    expect(events.map((e) => e.type)).toEqual([CONSENT_OPEN_EVENT]);
  });

  it('shows on a first visit, stays hidden once a choice is stored, and shows again when reopened', () => {
    expect(isBannerVisible('auto', null)).toBe(true);
    expect(isBannerVisible('auto', 'granted')).toBe(false);
    expect(isBannerVisible('auto', 'denied')).toBe(false);
    expect(isBannerVisible('reopened', 'granted')).toBe(true);
    expect(isBannerVisible('reopened', 'denied')).toBe(true);
    expect(isBannerVisible('closed', null)).toBe(false);
    expect(isBannerVisible('closed', 'granted')).toBe(false);
  });

  it('withdrawal (granted → denied) persists and reloads; other changes persist without a reload', () => {
    expect(choiceEffect('granted', 'denied')).toEqual({ persist: true, reload: true });
    expect(choiceEffect('denied', 'granted')).toEqual({ persist: true, reload: false });
    expect(choiceEffect(null, 'granted')).toEqual({ persist: true, reload: false });
    expect(choiceEffect(null, 'denied')).toEqual({ persist: true, reload: false });
  });

  it('re-picking the stored choice does nothing (no second consent_update → no duplicate page_view)', () => {
    expect(choiceEffect('granted', 'granted')).toEqual({ persist: false, reload: false });
    expect(choiceEffect('denied', 'denied')).toEqual({ persist: false, reload: false });
  });
});

describe('withdrawing consent', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubBrowser(jar: ReturnType<typeof cookieJar>, hostname = 'www.anna-ciok.studio') {
    const clarityCalls: unknown[][] = [];
    const fbqCalls: unknown[][] = [];
    vi.stubGlobal('document', jar);
    vi.stubGlobal('window', {
      dataLayer: [],
      location: { hostname },
      gtag: () => {},
      clarity: (...args: unknown[]) => { clarityCalls.push(args); },
      fbq: (...args: unknown[]) => { fbqCalls.push(args); },
      dispatchEvent: () => true,
    });
    return { clarityCalls, fbqCalls };
  }

  it('tells loaded Clarity (consentv2) and the Meta Pixel (revoke)', () => {
    const { clarityCalls, fbqCalls } = stubBrowser(cookieJar([]));
    setConsent('denied');
    expect(clarityCalls).toEqual([['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }]]);
    expect(fbqCalls).toEqual([['consent', 'revoke']]);
  });

  it('expires GA4, Google Ads, Meta and Clarity cookies on every domain, keeping essential cookies', () => {
    const jar = cookieJar([
      { name: '_ga', value: 'GA1.1.1.2', domain: 'anna-ciok.studio' },
      { name: '_ga_ABC123', value: 'GS1', domain: 'anna-ciok.studio' },
      { name: '_gcl_aw', value: 'GCL.1.x', domain: 'anna-ciok.studio' },
      { name: '_fbp', value: 'fb.1.2.3', domain: 'anna-ciok.studio' },
      { name: '_fbc', value: 'fb.1.2.x', domain: 'www.anna-ciok.studio' },
      { name: '_clck', value: 'c', domain: 'anna-ciok.studio' },
      { name: '_clsk', value: 's' },
      { name: COOKIE_NAME, value: 'granted' },
      { name: 'currency_pref', value: 'EUR' },
      { name: '__stripe_mid', value: 'm', domain: 'anna-ciok.studio' },
    ]);
    stubBrowser(jar);
    setConsent('denied');
    expect([...jar.entries.values()].map((c) => `${c.name}=${c.value}`).sort()).toEqual([
      '__stripe_mid=m',
      `${COOKIE_NAME}=denied`,
      'currency_pref=EUR',
    ]);
  });

  it('granting consent leaves the tags and cookies alone', () => {
    const jar = cookieJar([{ name: '_ga', value: 'GA1.1.1.2', domain: 'anna-ciok.studio' }]);
    const { clarityCalls, fbqCalls } = stubBrowser(jar);
    setConsent('granted');
    expect(clarityCalls).toEqual([]);
    expect(fbqCalls).toEqual([]);
    expect(jar.cookie).toContain('_ga=GA1.1.1.2');
  });

  it('a first-visit reject works before any tag has loaded (no clarity / fbq globals)', () => {
    vi.stubGlobal('document', cookieJar([]));
    vi.stubGlobal('window', { dataLayer: [], location: { hostname: 'localhost' }, dispatchEvent: () => true });
    expect(() => setConsent('denied')).not.toThrow();
  });

  it('only matches tracking cookie names', () => {
    expect(trackingCookieNames('_ga=1; _ga_X1=2; _gid=3; _gat_UA1=4; _gcl_au=5; _fbp=6; _fbc=7; _clck=8; _clsk=9')).toEqual(
      ['_ga', '_ga_X1', '_gid', '_gat_UA1', '_gcl_au', '_fbp', '_fbc', '_clck', '_clsk'],
    );
    expect(trackingCookieNames(`${COOKIE_NAME}=granted; currency_pref=GBP; _gallery=1; __stripe_sid=1; acc_auth_event=x`)).toEqual([]);
  });

  it('covers the host and every parent domain, never a bare TLD or an IP', () => {
    expect(cookieDomains('www.anna-ciok.studio')).toEqual(['www.anna-ciok.studio', 'anna-ciok.studio']);
    expect(cookieDomains('anna-ciok.studio')).toEqual(['anna-ciok.studio']);
    expect(cookieDomains('localhost')).toEqual([]);
    expect(cookieDomains('127.0.0.1')).toEqual([]);
  });
});
