import { getLocale, getTranslations } from 'next-intl/server';

/**
 * Plain POST form — /api/auth/signout revokes the session and 303s to `next`
 * (sanitized server-side): the locale-aware account page, which now shows the
 * signed-out panel in the visitor's own language.
 */
export async function SignOutButton() {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const next = locale === 'pl' ? '/konto' : `/${locale}/konto`;
  return (
    <form method="post" action="/api/auth/signout">
      <input type="hidden" name="next" value={next} />
      <button type="submit" className="btn btn-ghost account-signout" data-testid="konto-signout">
        {t('account.signOut')}
      </button>
    </form>
  );
}
