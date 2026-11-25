-- Owner decision 2026-11-25: the medium/large vase and large/wavy bowl
-- families stay public, but every remaining piece in them is no longer for
-- sale. Instead of hiding the families (PR #414, reverted), mark their 21
-- unsold drop-2 pieces as sold so they render as sold at the end of each
-- family and checkout refuses them (reserve_pieces conflicts on `sold`).
--
-- Ids verified against production on 2026-11-25 (all `available`, none
-- reserved, showroom = false):
--   wazony-srednie  u02 u03 u05 u06 u07
--   wazony-duze     d11 d15
--   duze-michy      b08 b10 b12 b13 b14 b15
--   miski-falowane  w18 w19 w20 w21 w22 w23 w24 w26
--
-- Only `available` rows are touched: a piece reserved by a live checkout in
-- the meantime keeps its reservation (and its order) and settles normally;
-- already-sold pieces keep their order_id.

update piece_state
set status = 'sold',
    reserved_until = null
where status = 'available'
  and product_id in (
    'u02', 'u03', 'u05', 'u06', 'u07',
    'd11', 'd15',
    'b08', 'b10', 'b12', 'b13', 'b14', 'b15',
    'w18', 'w19', 'w20', 'w21', 'w22', 'w23', 'w24', 'w26'
  );
