-- Dropping the (order_id, product_id) PK in 20260613120000 left order_id
-- lookups indexed only for ceramics (the partial unique index has
-- `where variant is null`). Fulfilment reads print rows by order_id
-- (process-job: `variant is not null`; stripe webhook: all rows), so give
-- order_id a plain index covering every row.
create index if not exists order_items_order_id_idx on order_items (order_id);
