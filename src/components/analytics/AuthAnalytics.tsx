'use client';

import { useEffect } from 'react';
import { buildLoginEvent, buildSignUpEvent, pushDataLayer, type AuthMethod } from '@/lib/analytics';
import { AUTH_EVENT_COOKIE } from '@/lib/auth/redirects';
import { readConsent } from '@/components/consent/consent-mode';

/**
 * Reads the one-shot `acc_auth_event` cookie the auth callback sets, emits the
 * login / sign_up dataLayer event (with user_id for GA4), then clears it — so a
 * later navigation never re-fires. No-op for anonymous traffic (no cookie).
 */
export function AuthAnalytics() {
  useEffect(() => {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_EVENT_COOKIE}=([^;]+)`));
    if (!m) return;
    // Clear immediately so a refresh can't double-fire.
    document.cookie = `${AUTH_EVENT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    // Defense-in-depth for the durable `user_id`: a denied-consent visitor must
    // never have user_id / an auth event pushed. The rest of the app relies on
    // GTM tag-gating (Consent Mode); this is the extra belt because user_id is a
    // durable identifier. Cookie is still cleared above, so no re-fire later.
    if (readConsent(document.cookie) !== 'granted') return;
    const [kind, method, userId] = decodeURIComponent(m[1]).split(':');
    if (!userId || (method !== 'google' && method !== 'apple')) return;
    if (kind === 'sign_up') pushDataLayer(buildSignUpEvent(method as AuthMethod, userId));
    else if (kind === 'login') pushDataLayer(buildLoginEvent(method as AuthMethod, userId));
  }, []);
  return null;
}
