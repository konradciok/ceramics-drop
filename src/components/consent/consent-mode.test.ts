import { describe, it, expect } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, readConsent } from './consent-mode';

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
    expect(readConsent('')).toBe(null);
  });
});
