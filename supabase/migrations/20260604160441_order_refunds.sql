-- A paid order whose charge was fully refunded or lost as a chargeback. Distinct
-- from 'failed' (payment never succeeded) so reversed sales are auditable.
-- NOTE: enum value additions are permanent — Postgres cannot drop an enum value.
alter type order_status add value if not exists 'refunded';
