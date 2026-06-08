export const COOKIE_NAME = 'ciok_consent';
export type ConsentValue = 'granted' | 'denied';

/** Inline script string: must run BEFORE GTM so defaults register first. */
export function defaultConsentSnippet(): string {
  return `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      'ad_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied',
      'analytics_storage': 'denied',
      'wait_for_update': 500
    });
  `;
}

export function readConsent(cookieString: string): ConsentValue | null {
  const match = cookieString.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const v = match.split('=')[1];
  return v === 'granted' || v === 'denied' ? v : null;
}

/** Client-only: persist choice + push the consent update to GTM. */
export function setConsent(value: ConsentValue): void {
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${60 * 60 * 24 * 180}; SameSite=Lax`;
  const state = value === 'granted' ? 'granted' : 'denied';
  // @ts-expect-error gtag is injected by the default snippet
  window.gtag?.('consent', 'update', {
    ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state,
  });
}
