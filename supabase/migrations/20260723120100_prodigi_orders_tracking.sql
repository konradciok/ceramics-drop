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

-- Safe cast: a malformed provider dispatchDate must degrade to NULL (matching
-- parseShippedAt in src/server/prodigi/callbacks.ts), never abort the migration.
create or replace function pg_temp.safe_timestamptz(v text) returns timestamptz
language plpgsql immutable as $fn$
begin
  return v::timestamptz;
exception when others then
  return null;
end
$fn$;

-- Backfill history from prodigi_raw_json. Shipment choice mirrors callbacks.ts:
-- first shipment WITH a tracking number, else first in array order. Only fills
-- NULLs, so the statement is idempotent and re-runnable. tracking_url follows
-- the same https-only rule as the runtime validator (httpsUrlOrNull) — the raw
-- payload keeps any rejected value for later reconciliation.
update prodigi_orders po
set carrier         = s.ship->'carrier'->>'name',
    tracking_number = s.ship->'tracking'->>'number',
    tracking_url    = case
                        when btrim(s.ship->'tracking'->>'url') ~* '^https://'
                        then btrim(s.ship->'tracking'->>'url')
                        else null
                      end,
    shipped_at      = pg_temp.safe_timestamptz(s.ship->>'dispatchDate')
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
