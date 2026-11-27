export const COOKIE_NAME = 'ciok_consent';
export type ConsentValue = 'granted' | 'denied';

/**
 * Dispatched on `window` whenever `setConsent()` runs, so a component that
 * gated something at mount time (e.g. `useGooglePlacesLoader`) can react to
 * a later consent change in the same page view instead of requiring a
 * reload.
 */
export const CONSENT_CHANGE_EVENT = 'ciok-consent-change';

/**
 * Dispatched on `window` by `openConsentSettings()` (the footer's "Cookie
 * settings" link, the privacy policy's cookies section). `ConsentBanner`
 * listens for it and reopens with the same two choices, so a visitor can
 * change or withdraw consent after the first choice (GDPR Art. 7(3)).
 */
export const CONSENT_OPEN_EVENT = 'ciok-consent-open';

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
      var m = document.cookie.match(/(?:^|;\\s*)${COOKIE_NAME}=(granted|denied)/);
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
  const match = cookieString.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const v = match.split('=')[1];
  return v === 'granted' || v === 'denied' ? v : null;
}

/** Client-only: reopen the consent banner (see `CONSENT_OPEN_EVENT`). */
export function openConsentSettings(): void {
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
}

/**
 * How the banner is showing: `auto` (first visit — shown only while no choice
 * is stored), `reopened` (the visitor asked for it via `openConsentSettings`),
 * or `closed` (a choice was made or the reopened banner was dismissed).
 */
export type BannerMode = 'auto' | 'reopened' | 'closed';

export function isBannerVisible(mode: BannerMode, stored: ConsentValue | null): boolean {
  if (mode === 'reopened') return true;
  if (mode === 'closed') return false;
  return stored === null;
}

/**
 * What a click on accept/reject must do, given the choice already stored.
 * - Same as stored: nothing. Re-sending `granted` would re-fire GTM's
 *   `ACC - Consent Update` trigger, which re-sends GA4 page_view and Meta
 *   PageView for the same page.
 * - granted → denied (withdrawal): persist, then reload. GA4's gtag.js, the
 *   Meta Pixel and Clarity are already loaded in this page view, and a loaded
 *   Google tag keeps sending cookieless pings after a `denied` update (the
 *   container is built for basic consent mode: no tag loads without consent).
 *   A reload is the only way to unload them.
 */
export function choiceEffect(
  stored: ConsentValue | null,
  chosen: ConsentValue,
): { persist: boolean; reload: boolean } {
  if (stored === chosen) return { persist: false, reload: false };
  return { persist: true, reload: stored === 'granted' && chosen === 'denied' };
}

/**
 * First-party cookies written by the consent-gated tags: GA4 / Google tag
 * (`_ga`, `_ga_<id>`, `_gid`, `_gat*`, `_gcl_*`), Meta Pixel (`_fbp`, `_fbc`)
 * and Microsoft Clarity (`_clck`, `_clsk`). Google and Meta do not delete
 * their cookies on a `denied` update, so withdrawal removes them here.
 * `ciok_consent`, `currency_pref`, auth and Stripe cookies are essential and
 * stay.
 */
const TRACKING_COOKIE = /^(?:_ga(?:_.+)?|_gid|_gat(?:_.+)?|_gcl_.+|_fbp|_fbc|_clck|_clsk)$/;

export function trackingCookieNames(cookieString: string): string[] {
  return cookieString
    .split(/;\s*/)
    .map((c) => c.split('=')[0]?.trim() ?? '')
    .filter((name) => TRACKING_COOKIE.test(name));
}

/**
 * The domains a cookie for `hostname` can have been written on: the host and
 * each parent with at least two labels (GA4 writes on the registrable domain,
 * e.g. `.anna-ciok.studio`). Empty for single-label hosts and IP addresses.
 */
export function cookieDomains(hostname: string): string[] {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return [];
  const labels = hostname.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Client-only: expire every tracking cookie (see `TRACKING_COOKIE`). */
export function clearTrackingCookies(): void {
  const names = trackingCookieNames(document.cookie);
  if (names.length === 0) return;
  const domains = cookieDomains(window.location?.hostname ?? '');
  for (const name of names) {
    // A cookie is only removed by a write with the same domain attribute, so
    // cover the host-only variant and every possible parent domain.
    document.cookie = `${name}=; path=/; max-age=0`;
    for (const domain of domains) document.cookie = `${name}=; path=/; domain=${domain}; max-age=0`;
  }
}

/** Client-only: persist choice + push the consent update to GTM. */
export function setConsent(value: ConsentValue): void {
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${60 * 60 * 24 * 180}; SameSite=Lax; Secure`;
  const state = value === 'granted' ? 'granted' : 'denied';
  // @ts-expect-error gtag is injected by the default snippet
  window.gtag?.('consent', 'update', {
    ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state,
  });
  if (value === 'denied') {
    // Tags already loaded in this page view (consent was granted earlier) are
    // told directly; on a first-visit reject neither exists, so both no-op.
    // Clarity: consentv2 `denied` deletes its cookies, ends the session and
    // switches to no-consent mode (learn.microsoft.com/clarity, "Clarity
    // Cookie Consent API - ConsentV2"). Never stub `window.clarity` here —
    // the GTM template creates it.
    const w = window as typeof window & { clarity?: (...args: unknown[]) => void; fbq?: (...args: unknown[]) => void };
    if (typeof w.clarity === 'function') {
      w.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
    }
    // Meta: `revoke` pauses Pixel fires for the rest of this page view
    // (developers.facebook.com/docs/meta-pixel/implementation/gdpr). Its GTM
    // tags are already blocked by the ad_storage consent check.
    if (typeof w.fbq === 'function') w.fbq('consent', 'revoke');
    clearTrackingCookies();
  }
  // GTM's Additional Consent Checks only gate a tag at the moment its own
  // trigger fires — they don't re-fire a previously-blocked tag when consent
  // updates later. This gives GTM's `ACC - Consent Update` trigger a fresh
  // moment to re-evaluate the base tags now that consent has changed. Pushed
  // directly (not via analytics.ts's pushDataLayer) since this event is a
  // GTM-internal signal that never reaches GA4/Meta — importing analytics.ts
  // here would drag the whole product catalog into every importer of this
  // file, including server-side readConsent callers like the checkout route.
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event: 'consent_update', consent_state: state });
  window.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT, { detail: { value } }));
}
