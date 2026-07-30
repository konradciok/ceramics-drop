-- Correlate a Resend send with its order so an inbound bounce/complaint webhook
-- can name the affected order. Set at customer order-confirmation send time,
-- beside confirmation_email_sent_at; resolved by resend_email_id on the inbound
-- /api/resend/webhook. Nullable — pre-existing orders and non-confirmation sends
-- stay NULL.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS resend_email_id TEXT;
CREATE INDEX IF NOT EXISTS orders_resend_email_id_idx
  ON orders (resend_email_id) WHERE resend_email_id IS NOT NULL;
