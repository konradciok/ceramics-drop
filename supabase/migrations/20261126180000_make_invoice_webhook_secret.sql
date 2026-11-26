-- Paid-order → Make.com invoicing hook: bring it under migrations and
-- authenticate it (security audit 2026-11-26, DB-01 / DB-02).
--
-- Until now the trigger, its function and the payload builder existed only on
-- production (created out of band). The function posted every paid order
-- (e-mail, name, amount) to a bare Make.com webhook URL written into the
-- function source, with no secret: anyone who learned the URL could post fake
-- "paid order" events into the invoicing scenario. Both functions also kept
-- the default PUBLIC execute grant.
--
-- After this migration:
--   * the webhook URL and a shared secret live in Supabase Vault, never in
--     the repository or the function source:
--       vault secret `make_invoice_webhook_url`    — the Make custom-webhook URL
--       vault secret `make_invoice_webhook_secret` — sent as `X-Invoice-Secret`
--     The Make scenario drops any request whose header does not match.
--   * if either Vault secret is missing, nothing is sent (fail closed) and a
--     warning is logged — the order update itself never fails because of the
--     invoice hook (same contract as before);
--   * execute is revoked from PUBLIC / anon / authenticated.
--
-- Operator setup (once per project, NOT in a migration — the repo is public):
--   select vault.create_secret('<make webhook url>',  'make_invoice_webhook_url',    'Make.com invoice webhook');
--   select vault.create_secret('<random 32+ bytes>', 'make_invoice_webhook_secret', 'X-Invoice-Secret for the Make invoice webhook');
-- Rotate with vault.update_secret(<id>, '<new value>').

create or replace function public.make_invoice_payload(o public.orders)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', 'evt_order_' || o.id::text,
    'type', 'checkout.session.completed',
    'data', jsonb_build_object('object', jsonb_build_object(
      'id', o.payment_intent_id,
      'object', 'checkout.session',
      'amount_total', o.cash_amount,
      'currency', lower(o.currency),
      'payment_intent', o.payment_intent_id,
      'metadata', jsonb_build_object('order_id', o.id::text, 'source', 'supabase_orders_trigger'),
      'customer_details', jsonb_build_object(
        'email', o.email,
        'name', nullif(btrim(coalesce(o.receiver_first_name,'') || ' ' || coalesce(o.receiver_last_name,'')), '')
      )
    ))
  );
$$;

create or replace function public.notify_make_order_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_secret text;
begin
  if new.status = 'paid'
     and new.payment_intent_id is not null
     and new.email is not null
     and coalesce(new.cash_amount, 0) > 0
     and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    -- Everything inside this block is best-effort: a missing extension, a
    -- missing Vault secret or a pg_net error must never roll back the order.
    begin
      select max(decrypted_secret) filter (where name = 'make_invoice_webhook_url'),
             max(decrypted_secret) filter (where name = 'make_invoice_webhook_secret')
        into v_url, v_secret
        from vault.decrypted_secrets
       where name in ('make_invoice_webhook_url', 'make_invoice_webhook_secret');

      if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
        raise warning 'notify_make_order_paid: vault secrets make_invoice_webhook_url / make_invoice_webhook_secret not set; invoice hook skipped for order %', new.id;
      else
        perform net.http_post(
          url := v_url,
          body := public.make_invoice_payload(new),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Invoice-Secret', v_secret
          ),
          timeout_milliseconds := 5000
        );
      end if;
    exception when others then
      raise warning 'notify_make_order_paid failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.make_invoice_payload(public.orders) from public, anon, authenticated;
revoke all on function public.notify_make_order_paid() from public, anon, authenticated;
grant execute on function public.make_invoice_payload(public.orders) to service_role;

drop trigger if exists trg_notify_make_order_paid on public.orders;
create trigger trg_notify_make_order_paid
  after insert or update of status on public.orders
  for each row execute function public.notify_make_order_paid();
