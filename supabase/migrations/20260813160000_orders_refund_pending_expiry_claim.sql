-- Plan 06 (M-5): two additive nullable columns on orders — no default, no backfill.
--
-- refund_pending_at: durable crash-window marker for the private-sale
--   double-payment state machine. The Stripe webhook sets it (CAS'd on
--   status='pending') BEFORE calling refunds.create, and clears it in the
--   pending→failed CAS. While set, pending-order consumers (abandoned-checkout
--   cron, admin release-reservation) must not act on the order — their expiry
--   claim is gated on refund_pending_at IS NULL.
--
-- expiry_claim_at: recoverable lease the pending-order consumers CAS before
--   their irreversible side effects (Stripe PI cancel / piece release),
--   mirroring webhook_events.processing_started_at. The terminal
--   pending→expired write is fenced to the claimant's own lease value; on a
--   side-effect failure the order stays 'pending' and the lease expires, so
--   the next sweep reclaims and retries.
--
-- Rollback note: a code revert must RETAIN both columns (additive, harmless
-- when unread; an in-flight row carrying a marker/lease would otherwise be
-- orphaned). Dropping them is a separate follow-up migration, only after all
-- code references are gone and no row still carries a value.
alter table orders
  add column if not exists refund_pending_at timestamptz,
  add column if not exists expiry_claim_at timestamptz;
