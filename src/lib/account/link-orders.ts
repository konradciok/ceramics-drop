import { getSupabaseAdmin } from '@/lib/supabase';

/** The subset of the Supabase Auth user the backfill needs. */
export type BackfillUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
};

/**
 * Backfill-on-login (plan §4.3): claim unclaimed guest orders whose email
 * matches this user's provider-VERIFIED address —
 *
 *   UPDATE orders SET user_id = :uid
 *   WHERE user_id IS NULL AND user_unlinked_at IS NULL
 *     AND lower(email) = lower(:verified_email)
 *
 * Runs on every login (cheap via the orders_unclaimed_email_idx partial
 * index), so guest purchases made between logins are swept up too. The
 * `user_id IS NULL` guard makes claims one-shot (first login wins, no
 * flapping); `user_unlinked_at IS NULL` permanently excludes orders released
 * by an account deletion. Orders created while signed-in are linked at insert
 * (checkout) — this only repairs history.
 */
export async function linkOrdersToUser(user: BackfillUser): Promise<void> {
  const email = user.email?.trim();
  if (!user.id || !email) return;
  // Defense in depth: only provider-verified emails may claim guest orders.
  // Google and Apple both assert verified emails and Supabase discards
  // unverified identity emails, so this is normally always true.
  if (!user.email_confirmed_at && !user.confirmed_at) return;

  const supabase = getSupabaseAdmin();
  // ilike with wildcards escaped ⇒ case-insensitive equality (lower() match).
  const escaped = email.replace(/([\\%_])/g, '\\$1');
  const { error } = await supabase
    .from('orders')
    .update({ user_id: user.id })
    .is('user_id', null)
    .is('user_unlinked_at', null)
    .ilike('email', escaped);
  if (error) throw error;
}
