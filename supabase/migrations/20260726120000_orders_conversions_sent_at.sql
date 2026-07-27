-- Claim column so server-side purchase conversions (Meta CAPI + GA4 MP) are sent
-- at most once per order. Closes the gap where a payment_intent.succeeded
-- redelivery (Stripe retries up to 3 days if a later step in the same handler
-- throws) re-sends past Meta's ~48h event_id dedup window, double-counting the
-- conversion. Mirrors orders.confirmation_email_sent_at / studio_email_sent_at.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS conversions_sent_at TIMESTAMPTZ;
