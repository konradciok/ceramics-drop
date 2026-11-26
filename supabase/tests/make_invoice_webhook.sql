-- pgTAP coverage for 20261126180000_make_invoice_webhook_secret.sql (security
-- audit 2026-11-26, DB-01 / DB-02): the paid-order → Make.com invoice hook is
-- defined in migrations, keeps no URL or secret in its source, is not callable
-- by anon/authenticated, and fails closed (never blocks the order) when its
-- Vault secrets are missing. Every assertion runs inside BEGIN/ROLLBACK.

begin;
set local search_path to extensions, public, pg_temp;

select plan(9);

select has_trigger('public', 'orders', 'trg_notify_make_order_paid', 'orders has the invoice trigger');

select ok(
  not has_function_privilege('anon', 'public.notify_make_order_paid()', 'execute')
    and not has_function_privilege('authenticated', 'public.notify_make_order_paid()', 'execute'),
  'anon/authenticated cannot execute notify_make_order_paid'
);
select ok(
  not has_function_privilege('anon', 'public.make_invoice_payload(public.orders)', 'execute')
    and not has_function_privilege('authenticated', 'public.make_invoice_payload(public.orders)', 'execute'),
  'anon/authenticated cannot execute make_invoice_payload'
);

select ok(
  (select prosrc not ilike '%make.com%' and prosrc not ilike '%https://%'
     from pg_proc where oid = 'public.notify_make_order_paid()'::regprocedure),
  'notify_make_order_paid source carries no webhook URL'
);
select ok(
  (select prosrc ilike '%X-Invoice-Secret%' and prosrc ilike '%vault.decrypted_secrets%'
     from pg_proc where oid = 'public.notify_make_order_paid()'::regprocedure),
  'notify_make_order_paid reads URL + secret from Vault and sends X-Invoice-Secret'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=public, pg_temp']
     from pg_proc where oid = 'public.notify_make_order_paid()'::regprocedure),
  'notify_make_order_paid is SECURITY DEFINER with a pinned search_path'
);

-- Fail closed: the local/CI stack never has these Vault secrets.

insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status, email)
values ('33333333-3333-4333-8333-333333333333', 'tap_make_pi_1', 10000, 0, 10000, 'odbior', 'pending', 'tap@example.test');

select lives_ok(
  $$ update orders set status = 'paid' where id = '33333333-3333-4333-8333-333333333333' $$,
  'pending → paid succeeds when the invoice hook has no Vault secrets'
);
select is(
  (select status from orders where id = '33333333-3333-4333-8333-333333333333'),
  'paid',
  'the order is paid despite the skipped hook'
);

select is(
  (select public.make_invoice_payload(o) -> 'data' -> 'object' -> 'metadata' ->> 'source'
     from orders o where id = '33333333-3333-4333-8333-333333333333'),
  'supabase_orders_trigger',
  'payload shape unchanged (metadata.source)'
);

select * from finish();
rollback;
