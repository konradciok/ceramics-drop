-- Allow GBP as a valid order currency alongside PLN and EUR.
-- The currency column has no prior CHECK constraint, so this adds one
-- covering all three values that the application may write.
alter table orders
  add constraint orders_currency_check
  check (currency in ('pln', 'eur', 'gbp'));
