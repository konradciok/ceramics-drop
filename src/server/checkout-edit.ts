/**
 * "Zmień" on the cart's payment step: take the buyer back to the delivery form.
 *
 * The open PaymentIntent cannot follow a delivery change — a new country or
 * method changes the amount, and a replay of the same attempt id with a new
 * amount is refused (`order_conflict`). So the edit retires the attempt
 * instead: the old PaymentIntent is cancelled, the old order expires, and the
 * pieces' reservation moves to the buyer's next attempt id
 * (`transfer_reservation`), so nobody else can take them while the form is
 * being corrected. The next checkout POST under that id is an ordinary one.
 *
 * Order of side effects (each step fenced, every failure path restores):
 *   1. lease the order (the same expiry lease the abandonment sweep and the
 *      admin release use — never two consumers at once, never a refund-pending
 *      order);
 *   2. move the hold to the next attempt BEFORE cancelling: the
 *      `payment_intent.canceled` webhook frees whatever the old order still
 *      holds, and it may land before step 4;
 *   3. cancel the PaymentIntent — if Stripe will not (the buyer is paying right
 *      now, or a transient error), move the hold back and release the lease;
 *   4. expire the old order (its pieces are already gone, so this frees
 *      nothing) and release its promo redemption — the next checkout claims it
 *      again.
 *
 * Authorisation is possession of the PaymentIntent's client_secret, which only
 * the buyer's browser holds (the same secret that lets it pay).
 *
 * v1 scope: plain cash orders. A gift-card (balance) order or a private-sale
 * order answers `edit_unsupported`; the cart does not offer the button there.
 */
import { timingSafeEqual } from '@/lib/timing-safe-equal';
import { isUuid } from '@/lib/uuid';
import type { CancelOutcome } from '@/lib/expire-orders';

export type EditableOrder = {
  id: string;
  status: string;
  payment_intent_id: string | null;
  private_sale_id: string | null;
  gift_card_id: string | null;
  promo_code: string | null;
};

export type CheckoutEditDeps = {
  loadOrder: (orderId: string) => Promise<EditableOrder | null>;
  /** The PaymentIntent's client_secret and metadata.order_id, or null when Stripe has none. */
  retrieveIntent: (paymentIntentId: string) => Promise<{ clientSecret: string | null; orderId: string | null } | null>;
  claimLease: (orderId: string) => Promise<string | null>;
  releaseLease: (orderId: string, claimToken: string) => Promise<void>;
  /** Moves the live hold from one order id to another; returns how many pieces moved. */
  transferHold: (from: string, to: string) => Promise<number>;
  cancelIntent: (paymentIntentId: string) => Promise<CancelOutcome>;
  /** Expire the old order (fenced to the lease) and release its promo redemption. */
  finalize: (order: EditableOrder, claimToken: string) => Promise<void>;
  log: (event: string, meta: Record<string, unknown>) => void;
};

export type CheckoutEditResult = { status: number; body: Record<string, unknown> };

/** `pi_<id>_secret_<secret>` → `pi_<id>`. */
const CLIENT_SECRET_RE = /^(pi_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+$/;

const fail = (status: number, error: string): CheckoutEditResult => ({ status, body: { error } });

export async function editCheckout(raw: unknown, deps: CheckoutEditDeps): Promise<CheckoutEditResult> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const orderId = typeof body.orderId === 'string' ? body.orderId : null;
  const nextAttemptId = typeof body.nextAttemptId === 'string' ? body.nextAttemptId : null;
  const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : '';
  const secretMatch = CLIENT_SECRET_RE.exec(clientSecret);
  if (!isUuid(orderId) || !isUuid(nextAttemptId) || orderId === nextAttemptId || !secretMatch) {
    return fail(400, 'bad_request');
  }
  const paymentIntentId = secretMatch[1];

  const order = await deps.loadOrder(orderId);
  // The same answer for "no such order" and "not your order": nothing to probe.
  if (!order || order.payment_intent_id !== paymentIntentId) return fail(403, 'forbidden');
  const intent = await deps.retrieveIntent(paymentIntentId);
  if (!intent?.clientSecret || !timingSafeEqual(intent.clientSecret, clientSecret) || intent.orderId !== orderId) {
    return fail(403, 'forbidden');
  }

  if (order.gift_card_id || order.private_sale_id) return fail(409, 'edit_unsupported');
  if (order.status !== 'pending') return fail(409, 'order_not_pending');

  const claimToken = await deps.claimLease(orderId);
  // Another consumer holds the order right now (or a refund is pending on it).
  if (!claimToken) return fail(409, 'checkout_in_progress');

  let moved: number;
  try {
    moved = await deps.transferHold(orderId, nextAttemptId);
  } catch (err) {
    deps.log('checkout_edit_transfer_failed', { orderId, error: String(err) });
    await deps.releaseLease(orderId, claimToken);
    return fail(503, 'edit_failed');
  }

  const outcome = await deps.cancelIntent(paymentIntentId);
  if (outcome !== 'canceled') {
    // Put the hold back where the still-open PaymentIntent expects it.
    try {
      await deps.transferHold(nextAttemptId, orderId);
    } catch (err) {
      // The PaymentIntent is still payable but its pieces now sit under the
      // next attempt id until the hold lapses: say so loudly.
      deps.log('checkout_edit_restore_failed', { orderId, nextAttemptId, error: String(err) });
    }
    await deps.releaseLease(orderId, claimToken);
    return outcome === 'paid' ? fail(409, 'payment_in_progress') : fail(503, 'edit_failed');
  }

  try {
    await deps.finalize(order, claimToken);
  } catch (err) {
    // The PaymentIntent is cancelled and the pieces have moved on, so the
    // buyer can carry on. The order stays pending with a lapsing lease; the
    // abandonment sweep expires it (its PI is already cancelled, it frees
    // nothing).
    deps.log('checkout_edit_finalize_failed', { orderId, error: String(err) });
  }
  return { status: 200, body: { ok: true, transferred: moved } };
}
