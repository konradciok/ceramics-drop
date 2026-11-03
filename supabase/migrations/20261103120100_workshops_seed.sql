-- ============================================================================
-- Workshops seed (2026-10-21)
-- The two workshops and their first calendar for workshops.anna-ciok.studio.
-- Prices, durations, group sizes and dates are PLACEHOLDERS until Anna
-- confirms them (the site shows "To confirm" chips and runs Stripe in test
-- mode meanwhile). Change them with a later data migration, not by editing this.
-- Image paths are served by the workshops Worker (public/images/).
-- ============================================================================

insert into workshops (id, slug, price_cents, currency, duration_min, capacity, pickup_after_days, cover, gallery, sort) values
  ('w_akwarela', 'akwarela', 6500, 'eur', 180, 10, null,
   '{"src":"/images/akwarela-brush.webp","w":1274,"h":1686}',
   '[{"src":"/images/swatches.webp","w":1394,"h":1702},{"src":"/images/brush-detail.webp","w":1782,"h":1690},{"src":"/images/circle.webp","w":1072,"h":1710}]',
   1),
  ('w_ceramika', 'ceramika', 7500, 'eur', 150, 8, 14,
   '{"src":"/images/studio-door.webp","w":1086,"h":1606}',
   '[{"src":"/images/studio-table.webp","w":1074,"h":1506},{"src":"/images/materials.webp","w":2376,"h":1612}]',
   2);

insert into workshop_sessions (id, workshop_id, starts_at, lang) values
  ('s03', 'w_akwarela', '2026-10-31 10:00', 'pl'),
  ('s04', 'w_akwarela', '2026-11-07 10:00', 'es'),
  ('s05', 'w_akwarela', '2026-11-18 17:30', 'en'),
  ('s06', 'w_akwarela', '2026-11-28 10:00', 'pl'),
  ('s07', 'w_akwarela', '2026-12-12 10:00', 'pl'),
  ('s11', 'w_ceramika', '2026-10-25 11:00', 'pl'),
  ('s12', 'w_ceramika', '2026-11-08 11:00', 'en'),
  ('s13', 'w_ceramika', '2026-11-22 11:00', 'pl'),
  ('s14', 'w_ceramika', '2026-12-06 11:00', 'es');
