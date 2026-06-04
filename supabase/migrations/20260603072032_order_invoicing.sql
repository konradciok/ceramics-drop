-- Separate idempotency signal for invoicing so webhook retries can re-attempt
-- a failed invoice without re-running fulfillment.
alter table orders add column invoiced_at timestamptz;
alter table orders add column invoice_id  text;
