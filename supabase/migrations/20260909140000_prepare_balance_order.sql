-- The order, line snapshots, ceramic reservation and gift-card hold are atomic.
create function prepare_balance_order(p_order jsonb,p_items jsonb,p_code text,p_fingerprint text,p_minimum_cash integer,p_private_token text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; inserted integer; ids text[]; conflicts text[];
begin
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 or length(p_fingerprint)<>64 then
    raise exception 'invalid_order_snapshot';
  end if;
  if (p_order->>'total')::integer<>(select sum((i->>'unit_price')::integer) from jsonb_array_elements(p_items) i)+(p_order->>'shipping')::integer
    or exists(select 1 from jsonb_array_elements(p_items) i where (i->>'unit_price')::integer<0 or i->'variant'->>'kind'='giftcard') then
    raise exception 'invalid_order_snapshot';
  end if;
  insert into orders(id,status,currency,subtotal,shipping,total,discount,shipping_method,delivery_method,fulfilment_type,
    email,receiver_first_name,receiver_last_name,receiver_phone,inpost_target_point,shipping_address,locale,marketing,private_sale_id,user_id,checkout_fingerprint)
  values((p_order->>'id')::uuid,'pending',p_order->>'currency',(p_order->>'subtotal')::integer,(p_order->>'shipping')::integer,
    (p_order->>'total')::integer,0,p_order->>'shipping_method',p_order->>'delivery_method',p_order->>'fulfilment_type',
    p_order->>'email',p_order->>'receiver_first_name',p_order->>'receiver_last_name',p_order->>'receiver_phone',p_order->>'inpost_target_point',
    nullif(p_order->'shipping_address','null'::jsonb),p_order->>'locale',p_order->'marketing',(p_order->>'private_sale_id')::uuid,(p_order->>'user_id')::uuid,p_fingerprint)
  on conflict(id) do nothing;
  get diagnostics inserted=row_count;
  select * into o from orders where id=(p_order->>'id')::uuid for update;
  if o.checkout_fingerprint is distinct from p_fingerprint then raise exception 'order_attempt_conflict'; end if;
  if inserted=1 then
    insert into order_items(order_id,product_id,unit_price,variant)
      select o.id,i->>'product_id',(i->>'unit_price')::integer,nullif(i->'variant','null'::jsonb) from jsonb_array_elements(p_items) i;
  end if;
  if o.status not in ('pending','paid') then raise exception 'order_attempt_conflict'; end if;
  perform reserve_gift_card(o.id,p_code,p_minimum_cash);
  if o.status='pending' and o.payment_intent_id is null then
    select array_agg(product_id order by product_id) into ids from order_items where order_id=o.id and variant is null;
    if cardinality(ids)>0 then
      if p_private_token is null then conflicts:=reserve_pieces(ids,o.id,900);
      else conflicts:=reserve_private_sale_pieces(p_private_token,ids,o.id,900); end if;
      if cardinality(conflicts)>0 then raise exception 'ceramic_unavailable'; end if;
    end if;
  end if;
  select * into o from orders where id=o.id;
  return to_jsonb(o);
end;
$$;
revoke all on function prepare_balance_order(jsonb,jsonb,text,text,integer,text) from public,anon,authenticated;
grant execute on function prepare_balance_order(jsonb,jsonb,text,text,integer,text) to service_role;
