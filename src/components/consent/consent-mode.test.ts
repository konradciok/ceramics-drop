import { describe, it, expect, vi } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, CONSENT_CHANGE_EVENT, readConsent, setConsent } from './consent-mode';

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
