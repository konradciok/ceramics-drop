-- Claim column for the "print refunded but Prodigi order not cancellable" alert.
-- cancelPrintFulfilment CAS-claims it (UPDATE … WHERE IS NULL) before alerting,
-- so the admin-refund path and the later charge.refunded webhook can both run
-- the helper without double-alerting the studio.
alter table prodigi_orders add column if not exists cancel_alerted_at timestamptz;
