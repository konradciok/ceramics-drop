-- Extend the allowed order currencies to include USD and CAD, alongside the
-- existing PLN / EUR / GBP. The currency column is a plain `text` column whose
-- values are constrained by the `orders_currency_check` CHECK constraint added
-- in 20260614180000_add_gbp_currency.sql. Drop and recreate that constraint so
-- 'usd' and 'cad' become valid values the application may write.
alter table orders
  drop constraint if exists orders_currency_check;

alter table orders
  add constraint orders_currency_check
  check (currency in ('pln', 'eur', 'gbp', 'usd', 'cad'));
