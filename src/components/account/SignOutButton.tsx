import { getTranslations } from 'next-intl/server';

/** Plain POST form — /api/auth/signout revokes the session and 303s home. */
export async function SignOutButton() {
  const t = await getTranslations();
  return (
    <form method="post" action="/api/auth/signout">
      <button type="submit" className="btn btn-ghost account-signout" data-testid="konto-signout">
        {t('account.signOut')}
      </button>
    </form>
  );
}
