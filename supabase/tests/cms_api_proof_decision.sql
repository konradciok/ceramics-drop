-- pgTAP coverage for decide_print_proof. Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(8);

insert into products (id, type, category_slug, num, status) values
  ('tap_proof_product', 'print', 'fine-art-prints', '77', 'draft');

insert into product_drafts (product_id, revision, payload) values
  ('tap_proof_product', 1, '{"type":"print"}'::jsonb);

insert into print_fulfilment_assets (
  id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status
) values (
  '92000000-0000-0000-0000-000000000001',
  'tap_proof_product', 'r1', 'prints/tap_proof_product/r1/a.jpg', 'sha', 'image/jpeg', 100, 200, 10, 'staged'
);

select throws_ok(
  $$ select decide_print_proof('99999999-9999-9999-9999-999999999999', 'approve', 1, null) $$,
  'proof_not_found',
  'decide_print_proof: unknown asset id is rejected'
);

select throws_ok(
  $$ select decide_print_proof('92000000-0000-0000-0000-000000000001', 'approve', 0, null) $$,
  'revision_conflict',
  'decide_print_proof: stale expectedRevision is rejected'
);

select is(
  (decide_print_proof('92000000-0000-0000-0000-000000000001', 'approve', 1, 'anna@studio.pl'))->>'productId',
  'tap_proof_product',
  'decide_print_proof: approve returns the owning product id'
);

select is(
  (select pfa.status from print_fulfilment_assets pfa where pfa.id = '92000000-0000-0000-0000-000000000001'),
  'ready',
  'decide_print_proof: approve moves staged -> ready'
);

select ok(
  (select pfa.verified_at is not null from print_fulfilment_assets pfa where pfa.id = '92000000-0000-0000-0000-000000000001'),
  'decide_print_proof: approve stamps verified_at'
);

select is(
  (select cal.action from catalog_audit_log cal where cal.product_id = 'tap_proof_product' order by cal.created_at desc limit 1),
  'proof_approved',
  'decide_print_proof: writes a proof_approved audit row'
);

select throws_ok(
  $$ select decide_print_proof('92000000-0000-0000-0000-000000000001', 'reject', 1, null) $$,
  'invalid_proof_transition',
  'decide_print_proof: an already-ready asset cannot be decided again'
);

select ok(
  not has_function_privilege('anon', 'decide_print_proof(uuid,text,integer,text)', 'execute'),
  'decide_print_proof: anon cannot execute'
);

select * from finish();
rollback;
