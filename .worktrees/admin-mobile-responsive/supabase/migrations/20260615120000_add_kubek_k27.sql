-- New kubek from studio inventory k31 (stable id k27, image kubek-31.webp)
INSERT INTO piece_state (product_id, status)
VALUES ('k27', 'available')
ON CONFLICT (product_id) DO NOTHING;
