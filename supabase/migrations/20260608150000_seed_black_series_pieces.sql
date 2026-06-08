-- Seed the 8 newly added black-on-cream pieces as available.
--
-- These extend the existing families:
--   kubki           → k23, k24, k25, k26
--   wazony          → v09
--   wazony-duze     → d10  (image waza-duza-11)
--   duze-michy      → b07
--   miski-falowane  → w17
--
-- Without rows here the pieces are unsellable: reserve_pieces() and the
-- paid/sold UPDATE paths both filter on existing product_id rows, so a
-- missing row means a checkout silently reserves nothing and the piece can
-- never be marked sold (it would stay "available" forever after purchase).
insert into piece_state (product_id, status) values
  ('k23', 'available'),
  ('k24', 'available'),
  ('k25', 'available'),
  ('k26', 'available'),
  ('v09', 'available'),
  ('d10', 'available'),
  ('b07', 'available'),
  ('w17', 'available')
on conflict (product_id) do nothing;
