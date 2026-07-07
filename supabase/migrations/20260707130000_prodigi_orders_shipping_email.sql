-- Claim column for the print shipping-confirmation email (Prodigi callback,
-- stage Complete). Claimed before sending (UPDATE … WHERE IS NULL) so a
-- replayed callback can never re-send — same pattern as orders.*_email_sent_at.
alter table prodigi_orders add column if not exists shipping_email_sent_at timestamptz;
