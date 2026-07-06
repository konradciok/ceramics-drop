-- Add sent-at timestamp so the studio new-order notification is idempotent
-- across Stripe webhook retries (payment_intent.succeeded can fire more than
-- once), mirroring confirmation_email_sent_at.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS studio_email_sent_at TIMESTAMPTZ;
