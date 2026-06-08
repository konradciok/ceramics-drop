-- Harden reserve_pieces against search_path hijacking (Supabase security advisor:
-- function_search_path_mutable). The function body references the unqualified
-- table `piece_state` (in the public schema), so pin search_path to
-- `public, pg_temp` rather than an empty path. Signature is unique
-- (text[], uuid, integer); the explicit arg list keeps this unambiguous.
alter function public.reserve_pieces(text[], uuid, integer)
  set search_path = public, pg_temp;
