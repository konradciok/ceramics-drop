-- June 2026 inventory review (spotkanie z artystką).
-- Aligns piece_state with the rebuilt catalogue in src/lib/products.ts.
--
-- Catalogue ids are intentionally STABLE: surviving pieces keep their id and
-- only their display number (num) / category change. So this migration only
-- needs to (a) drop rows for pieces withdrawn from sale and (b) add the one
-- catalogue id that never had a row. The single ordered/sold piece (p10) is
-- left untouched, so order history stays intact.
--
-- Idempotent: safe to re-run.

begin;

-- Pieces removed from the catalogue: sold-out, duplicates, or merged into
-- another piece as a second photo (gallery). Guarded on status = 'available'
-- so a sold/reserved piece can never be deleted by accident.
delete from piece_state
where status = 'available'
  and product_id in (
    'k15', 'k16',                                  -- kubki: out
    'v08', 'd04', 'd08',                           -- wazy: out / duplicate
    't03',                                         -- talerzyki: out
    'p04', 'p06', 'p11',                           -- talerze duże: out
    'b05', 'b06',                                  -- duże misy: out (galeria później)
    'w01', 'w02', 'w04', 'w10',                    -- miski falowane: out
    'w11', 'w13', 'w16'                            -- miski falowane: scalone jako 2. zdjęcie
  );

-- k01 had no piece_state row. reserve_pieces() only UPDATEs existing rows, so
-- without this a checkout for k01 would silently fail to reserve the piece.
insert into piece_state (product_id, status)
values ('k01', 'available')
on conflict (product_id) do nothing;

commit;
