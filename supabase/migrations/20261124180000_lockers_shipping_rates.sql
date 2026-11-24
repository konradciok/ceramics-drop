-- Locker shipping by price zone, for shipping from mainland Spain
-- (docs/plans/2026-11-24-inpost-international-shipping-plan.md §5).
--
-- EXPAND ONLY: adds a third shipping_rates resource, 'lockers', next to
-- 'domestic' and 'international', seeded and published at revision 1. No code
-- reads it yet. src/lib/shipping-rates/load.ts fails the whole bundle over to
-- the code constants when a resource it expects is missing, so the code that
-- reads 'lockers' ships in a later release, after this row is live.
--
-- Two zones × three currencies (owner decision 2026-11-24, each currency set
-- independently, never FX-derived):
--   es — Spain                                           10 € · 43 zł · 9 £
--   eu — every other destination, Poland included        15 € · 65 zł · 13 £
-- The 'eu' zone equals the currently published 'domestic' paczkomat rates
-- (revision 2, 2026-11-24), so moving Polish orders onto it changes no price.
--
-- shipping_rate_field_keys() is redefined with the 'lockers' case added; the
-- 'domestic' and 'international' cases are copied verbatim from
-- 20260917150000_cms_api_shipping_rates.sql.

create or replace function shipping_rate_field_keys(p_rate_id text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_rate_id
    when 'domestic' then array[
      'paczkomat_pln', 'kurier_pln', 'odbior_pln',
      'paczkomat_eur', 'kurier_eur', 'odbior_eur',
      'paczkomat_gbp', 'kurier_gbp', 'odbior_gbp'
    ]
    when 'international' then (
      select array_agg(lower(c.code) || '_' || p.pack || '_eur' order by c.ord, p.ord)
        from unnest(array[
          'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
          'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
          'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB'
        ]) with ordinality as c(code, ord)
        cross join (values ('framed', 1), ('loose', 2)) as p(pack, ord)
    )
    when 'lockers' then array[
      'es_pln', 'es_eur', 'es_gbp',
      'eu_pln', 'eu_eur', 'eu_gbp'
    ]
  end;
$$;

revoke all on function shipping_rate_field_keys(text) from public, anon, authenticated;
grant execute on function shipping_rate_field_keys(text) to service_role;

insert into shipping_rates (id) values ('lockers');

with lockers_seed(key, label, value, ord) as (values
  ('es_pln', 'Hiszpania — paczkomat / punkt InPost (PLN)',       '43', 1),
  ('es_eur', 'Hiszpania — paczkomat / punkt InPost (EUR)',       '10', 2),
  ('es_gbp', 'Hiszpania — paczkomat / punkt InPost (GBP)',       '9',  3),
  ('eu_pln', 'Pozostałe kraje — paczkomat / punkt InPost (PLN)', '65', 4),
  ('eu_eur', 'Pozostałe kraje — paczkomat / punkt InPost (EUR)', '15', 5),
  ('eu_gbp', 'Pozostałe kraje — paczkomat / punkt InPost (GBP)', '13', 6)
)
insert into shipping_rate_drafts (rate_id, revision, payload, created_by)
select
  'lockers',
  1,
  jsonb_build_object('fields', (
    select jsonb_agg(
             jsonb_build_object(
               'key', s.key, 'label', s.label, 'type', 'number',
               'value', s.value, 'locale', 'none', 'sourceLocale', 'none'
             )
             order by s.ord
           )
      from lockers_seed s
  )),
  'migration:20261124180000_lockers_shipping_rates';

update shipping_rates r set published_revision = 1, published_at = now() where r.id = 'lockers';

-- Same in-database lockstep guard as the original backfill: the seeded payload
-- must carry exactly the publishable keys, in order.
do $$
declare
  v_keys text[];
begin
  select array_agg(t.f->>'key' order by t.ord)
    into v_keys
    from shipping_rate_drafts d
    cross join lateral jsonb_array_elements(d.payload->'fields') with ordinality as t(f, ord)
   where d.rate_id = 'lockers'
     and d.revision = 1;

  if v_keys is distinct from shipping_rate_field_keys('lockers') then
    raise exception 'shipping_rate_backfill_key_mismatch' using detail = 'rateId=lockers';
  end if;
end $$;

insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
select d.rate_id, null, 'published', null, d.payload, 1
from shipping_rate_drafts d
where d.rate_id = 'lockers' and d.revision = 1;
