export const COOKIE_NAME = 'ciok_consent';
export type ConsentValue = 'granted' | 'denied';

/**
 * Inline script string: must run BEFORE GTM so defaults register first. It also
 * restores a returning visitor's stored consent in the SAME beforeInteractive
 * block — otherwise GTM would load with everything denied even after the user
 * had accepted (the banner only calls `update` on click, which never re-runs on
 * reload). Per Google Consent Mode v2, the CMP must read persisted consent and
 * call `update` before the GTM script.
 */
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
    try {
      var m = document.cookie.match(/(?:^|; )${COOKIE_NAME}=(granted|denied)/);
      if (m && m[1] === 'granted') {
        gtag('consent', 'update', {
          'ad_storage': 'granted',
          'ad_user_data': 'granted',
          'ad_personalization': 'granted',
          'analytics_storage': 'granted'
        });
      }
    } catch (e) {}
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
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${60 * 60 * 24 * 180}; SameSite=Lax; Secure`;
  const state = value === 'granted' ? 'granted' : 'denied';
  // @ts-expect-error gtag is injected by the default snippet
  window.gtag?.('consent', 'update', {
    ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state,
  });
}
