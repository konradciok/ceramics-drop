-- 21 new medium plates (s03–s23, images sredni-talerz-19..39)
INSERT INTO piece_state (product_id, status)
VALUES
  ('s03', 'available'), ('s04', 'available'), ('s05', 'available'),
  ('s06', 'available'), ('s07', 'available'), ('s08', 'available'),
  ('s09', 'available'), ('s10', 'available'), ('s11', 'available'),
  ('s12', 'available'), ('s13', 'available'), ('s14', 'available'),
  ('s15', 'available'), ('s16', 'available'), ('s17', 'available'),
  ('s18', 'available'), ('s19', 'available'), ('s20', 'available'),
  ('s21', 'available'), ('s22', 'available'), ('s23', 'available')
ON CONFLICT (product_id) DO NOTHING;
