-- Tracks the courier pickup dispatch order created via ShipX API (courier orders only).
-- Tracks return shipments initiated via POST /api/returns (replaces manual WebTrucker portal steps).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS inpost_dispatch_order_id TEXT,
  ADD COLUMN IF NOT EXISTS inpost_return_shipment_id TEXT,
  ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_label_emailed_at TIMESTAMPTZ;
