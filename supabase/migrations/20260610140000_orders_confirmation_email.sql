-- Add sent-at timestamp so customer confirmation email is idempotent across
-- Stripe webhook retries (payment_intent.succeeded can fire more than once).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
