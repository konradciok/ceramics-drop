import { getTranslations } from 'next-intl/server';

/**
 * Plain POST form — /api/auth/signout revokes the session and 303s to the
 * sanitized `next` path (the caller's localized account page), so signing out
 * of /en/konto never strands the customer on the Polish homepage.
 */
export async function SignOutButton(props: { next: string }) {
  const t = await getTranslations();
  return (
    <form method="post" action="/api/auth/signout">
      <input type="hidden" name="next" value={props.next} />
      <button type="submit" className="btn btn-ghost account-signout" data-testid="konto-signout">
        {t('account.signOut')}
      </button>
    </form>
  );
}
