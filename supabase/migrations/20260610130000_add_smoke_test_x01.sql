-- Smoke-test product x01 (kubki, 8 PLN, ~2 EUR) used for production payment verification.
-- reserve_pieces() only UPDATEs existing rows, so without this row checkout silently
-- fails to reserve the piece and it can never be marked sold.
-- Remove this row (and the x01 spec in products.ts) after prod payment is verified.
INSERT INTO piece_state (product_id, status)
VALUES ('x01', 'available')
ON CONFLICT (product_id) DO NOTHING;
