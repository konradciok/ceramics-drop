-- drop-2 vases: piece_state rows for the 17 new pieces (docs/new-drop-runbook.md § 1.5).
--
-- Registry: src/lib/products.ts SPECS with dropId 'drop-2' (existing family
-- prefixes continued via startAt; ids checked free in production 2026-11-23)
--   v10–v15  wazony          (wazon-maly-1…6)
--   u02–u07  wazony-srednie  (wazon-sredni-1…6)
--   d11–d15  wazony-duze     (wazon-duzy-1…5)
--
-- Without a row a piece is silently unbuyable (reserve_pieces treats it as a
-- conflict). The pieces stay hidden until drop-2 is launched (drops.status
-- 'upcoming' → 'active' via npm run drop:launch). Idempotent.

insert into piece_state (product_id, status, showroom)
values
  ('v10', 'available', false), ('v11', 'available', false), ('v12', 'available', false),
  ('v13', 'available', false), ('v14', 'available', false), ('v15', 'available', false),
  ('u02', 'available', false), ('u03', 'available', false), ('u04', 'available', false),
  ('u05', 'available', false), ('u06', 'available', false), ('u07', 'available', false),
  ('d11', 'available', false), ('d12', 'available', false), ('d13', 'available', false),
  ('d14', 'available', false), ('d15', 'available', false)
on conflict (product_id) do nothing;
