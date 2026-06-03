-- InPost ShipX delivery fields on orders.
-- Additive + nullable so existing 0001 rows stay valid. Captured at checkout:
-- the chosen method, receiver contact, and (for Paczkomat) the locker code.
-- Populated after payment: the ShipX shipment id, tracking number, status, and
-- a once-only guard for the label email.

alter table orders
  add column if not exists delivery_method        text,   -- 'paczkomat' | 'kurier' | 'odbior'
  add column if not exists receiver_first_name     text,
  add column if not exists receiver_last_name      text,
  add column if not exists receiver_phone          text,
  add column if not exists inpost_target_point     text,   -- Paczkomat code, e.g. 'KRA010'
  add column if not exists inpost_shipment_id       text,
  add column if not exists inpost_tracking_number   text,
  add column if not exists delivery_status          text,  -- mirrors ShipX shipment status
  add column if not exists inpost_label_emailed_at  timestamptz;

-- Look up an order from an inbound InPost status webhook by its shipment id.
create index if not exists orders_inpost_shipment_id_idx
  on orders (inpost_shipment_id);
