-- Claim payment mode before either path calls Stripe. A read-before-create
-- check alone cannot fence two tabs starting different modes concurrently.
create table checkout_payment_modes (
  order_id uuid primary key,
  mode text not null check (mode in ('cash','balance')),
  created_at timestamptz not null default now()
);
alter table checkout_payment_modes enable row level security;
revoke all on checkout_payment_modes from public,anon,authenticated;
grant select on checkout_payment_modes to service_role;

create function claim_checkout_payment_mode(p_order_id uuid,p_mode text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare prior text;
begin
  if p_mode is null or p_mode not in ('cash','balance') then raise exception 'invalid_payment_mode'; end if;
  select case when gift_card_id is null then 'cash' else 'balance' end into prior from orders where id=p_order_id;
  insert into checkout_payment_modes(order_id,mode) values(p_order_id,coalesce(prior,p_mode)) on conflict(order_id) do nothing;
  select mode into prior from checkout_payment_modes where order_id=p_order_id;
  return prior=p_mode;
end;
$$;
revoke all on function claim_checkout_payment_mode(uuid,text) from public,anon,authenticated;
grant execute on function claim_checkout_payment_mode(uuid,text) to service_role;
