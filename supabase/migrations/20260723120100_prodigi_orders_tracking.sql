-- Persist print tracking (previously only extracted in memory for the shipping
-- email in src/server/prodigi/callbacks.ts). Also closes the admin visibility
-- gap. V1 scope: these columns describe the PRIMARY shipment (first with a
-- tracking number, else first in array order — exactly the shipment the
-- shipping email cites); the complete shipments[] array remains losslessly in
-- prodigi_raw_json.
alter table prodigi_orders
  add column if not exists carrier         text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url    text,
  add column if not exists shipped_at      timestamptz;

-- Backfill history from prodigi_raw_json. Shipment choice mirrors callbacks.ts:
-- first shipment WITH a tracking number, else first in array order. Only fills
-- NULLs, so the statement is idempotent and re-runnable.
update prodigi_orders po
set carrier         = s.ship->'carrier'->>'name',
    tracking_number = s.ship->'tracking'->>'number',
    tracking_url    = s.ship->'tracking'->>'url',
    shipped_at      = nullif(s.ship->>'dispatchDate', '')::timestamptz
from (
  select p.id,
         (select sh.value
            from jsonb_array_elements(coalesce(p.prodigi_raw_json->'shipments', '[]'::jsonb))
                 with ordinality sh(value, ord)
           order by (sh.value->'tracking'->>'number') is null, sh.ord
           limit 1) as ship
  from prodigi_orders p
) s
where po.id = s.id
  and s.ship is not null
  and po.tracking_number is null;
