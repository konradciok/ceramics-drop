-- drop-2 ("Drop Świąteczny"): the drops row plus piece_state rows for the 125
-- new pieces (docs/new-drop-runbook.md § 1).
--
-- Registry: src/lib/products.ts SPECS with dropId 'drop-2' (existing family
-- prefixes continued via startAt; ids checked free in production 2026-11-23)
--   v10–v15  wazony          (wazon-maly-1…6)
--   u02–u07  wazony-srednie  (wazon-sredni-1…6)
--   d11–d15  wazony-duze     (wazon-duzy-1…5)
--   k28–k45  kubki           (kubek-drop2-1…18)
--   b08–b15  duze-michy      (miska-duza-1…8)
--   w18–w26  miski-falowane  (miska-falowana-1…9)
--   e01–e12  talerze-owalne  (talerz-owalny-1…12) — new family
--   p13–p26  talerze-duze    (talerz-duzy-drop2-1…15, no 6)
--   s24–s61  talerze-srednie (talerz-sredni-1…38)
--   m01–m09  talerze-male    (talerz-smallest-1…9) — new family
--
-- Without a row a piece is silently unbuyable (reserve_pieces treats it as a
-- conflict). The pieces stay hidden until drop-2 is launched (drops.status
-- 'upcoming' → 'active' via npm run drop:launch). Idempotent.

-- The drop itself, as `upcoming`: products.drop_id has an FK to drops, so the
-- row must exist before `npm run catalog:backfill` seeds e.g. k28 with
-- drop_id 'drop-2' (the CI fresh-schema backfill rehearsal enforces this).
-- Same as drop-1, which 20260709130000_showroom_drops.sql seeded. An upcoming
-- drop is invisible; `npm run drop:launch -- --id drop-2 --confirm drop-2`
-- activates it.
insert into drops (id, label, status)
values ('drop-2', 'Drop Świąteczny', 'upcoming')
on conflict (id) do nothing;

insert into piece_state (product_id, status, showroom)
values
  ('v10', 'available', false), ('v11', 'available', false), ('v12', 'available', false),
  ('v13', 'available', false), ('v14', 'available', false), ('v15', 'available', false),
  ('u02', 'available', false), ('u03', 'available', false), ('u04', 'available', false),
  ('u05', 'available', false), ('u06', 'available', false), ('u07', 'available', false),
  ('d11', 'available', false), ('d12', 'available', false), ('d13', 'available', false),
  ('d14', 'available', false), ('d15', 'available', false),
  ('k28', 'available', false), ('k29', 'available', false), ('k30', 'available', false),
  ('k31', 'available', false), ('k32', 'available', false), ('k33', 'available', false),
  ('k34', 'available', false), ('k35', 'available', false), ('k36', 'available', false),
  ('k37', 'available', false), ('k38', 'available', false), ('k39', 'available', false),
  ('k40', 'available', false), ('k41', 'available', false), ('k42', 'available', false),
  ('k43', 'available', false), ('k44', 'available', false), ('k45', 'available', false),
  ('b08', 'available', false), ('b09', 'available', false), ('b10', 'available', false),
  ('b11', 'available', false), ('b12', 'available', false), ('b13', 'available', false),
  ('b14', 'available', false), ('b15', 'available', false),
  ('w18', 'available', false), ('w19', 'available', false), ('w20', 'available', false),
  ('w21', 'available', false), ('w22', 'available', false), ('w23', 'available', false),
  ('w24', 'available', false), ('w25', 'available', false), ('w26', 'available', false),
  ('e01', 'available', false), ('e02', 'available', false), ('e03', 'available', false),
  ('e04', 'available', false), ('e05', 'available', false), ('e06', 'available', false),
  ('e07', 'available', false), ('e08', 'available', false), ('e09', 'available', false),
  ('e10', 'available', false), ('e11', 'available', false), ('e12', 'available', false),
  ('p13', 'available', false), ('p14', 'available', false), ('p15', 'available', false),
  ('p16', 'available', false), ('p17', 'available', false), ('p18', 'available', false),
  ('p19', 'available', false), ('p20', 'available', false), ('p21', 'available', false),
  ('p22', 'available', false), ('p23', 'available', false), ('p24', 'available', false),
  ('p25', 'available', false), ('p26', 'available', false),
  ('s24', 'available', false), ('s25', 'available', false), ('s26', 'available', false),
  ('s27', 'available', false), ('s28', 'available', false), ('s29', 'available', false),
  ('s30', 'available', false), ('s31', 'available', false), ('s32', 'available', false),
  ('s33', 'available', false), ('s34', 'available', false), ('s35', 'available', false),
  ('s36', 'available', false), ('s37', 'available', false), ('s38', 'available', false),
  ('s39', 'available', false), ('s40', 'available', false), ('s41', 'available', false),
  ('s42', 'available', false), ('s43', 'available', false), ('s44', 'available', false),
  ('s45', 'available', false), ('s46', 'available', false), ('s47', 'available', false),
  ('s48', 'available', false), ('s49', 'available', false), ('s50', 'available', false),
  ('s51', 'available', false), ('s52', 'available', false), ('s53', 'available', false),
  ('s54', 'available', false), ('s55', 'available', false), ('s56', 'available', false),
  ('s57', 'available', false), ('s58', 'available', false), ('s59', 'available', false),
  ('s60', 'available', false), ('s61', 'available', false),
  ('m01', 'available', false), ('m02', 'available', false), ('m03', 'available', false),
  ('m04', 'available', false), ('m05', 'available', false), ('m06', 'available', false),
  ('m07', 'available', false), ('m08', 'available', false), ('m09', 'available', false)
on conflict (product_id) do nothing;
