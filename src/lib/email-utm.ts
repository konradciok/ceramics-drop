/**
 * UTM tags for storefront links in emails the app sends.
 *
 * Mail clients strip or replace the referrer (the Gmail app arrives as
 * `android-app://com.google.android.gm/`), so an untagged email link lands in
 * GA4 as "(not set)" / Unassigned and the purchase it leads to loses its
 * source. `utm_medium=email` puts these visits in GA4's Email channel.
 * Hand-sent Resend broadcasts use `utm_source=newsletter&utm_medium=email`;
 * the app's own emails follow the same scheme.
 */
export type EmailUtmSource = 'newsletter' | 'transactional';

export type EmailUtmCampaign = 'abandoned_checkout' | 'newsletter_welcome' | 'order_shipped';

/** `url` with utm_source / utm_medium / utm_campaign set (existing params kept). */
export function withEmailUtm(url: string, source: EmailUtmSource, campaign: EmailUtmCampaign): string {
  const u = new URL(url);
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', 'email');
  u.searchParams.set('utm_campaign', campaign);
  return u.toString();
}
