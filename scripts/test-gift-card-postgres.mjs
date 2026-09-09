// Isolated real PostgreSQL tests; never accepts a production database URL.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { default: EmbeddedPostgres } = await import(process.argv[2]);
const cluster = new EmbeddedPostgres({ databaseDir: process.argv[3],user:'postgres',password:randomUUID(),port:57654,persistent:true,createPostgresUser:false,postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){} });
const clients=[];
try {
  await cluster.initialise(); await cluster.start();
  const db=cluster.getPgClient(); await db.connect(); clients.push(db);
  await db.query(`create role anon;create role authenticated;create role service_role;
    create table orders(id uuid primary key default gen_random_uuid(),payment_intent_id text,subtotal integer,shipping integer default 0,total integer,currency text default 'pln',status text default 'pending',paid_at timestamptz,fulfilment_type text default 'prodigi',promo_code text,discount integer default 0,
      shipping_method text,delivery_method text,email text,receiver_first_name text,receiver_last_name text,receiver_phone text,inpost_target_point text,shipping_address jsonb,locale text,marketing jsonb,private_sale_id uuid,user_id uuid,refund_pending_at timestamptz,expiry_claim_at timestamptz);
    create table order_items(order_id uuid,product_id text,unit_price integer,variant jsonb);
    create table drops(id text primary key,label text,status text);
    create table products(id text primary key,type text,status text,drop_id text references drops(id));
    create table private_sales(id uuid primary key default gen_random_uuid(),token text,product_ids text[],consumed_at timestamptz,expires_at timestamptz);
    create table piece_state(product_id text primary key,order_id uuid,status text,reserved_until timestamptz,showroom boolean default false);`);
  const legacy = await readFile('supabase/migrations/20260813170000_harden_rpc_and_catalog.sql','utf8');
  const from = legacy.indexOf('create or replace function reserve_pieces(');
  await db.query(legacy.slice(from,legacy.indexOf('-- =============================================================================',from)));
  await db.query(await readFile('supabase/migrations/20260909120000_active_drop_purchase_guard.sql','utf8'));
  await db.query(await readFile('supabase/migrations/20260909130000_gift_card_balance_ledger.sql','utf8'));
  await db.query(await readFile('supabase/migrations/20260909140000_prepare_balance_order.sql','utf8'));
  await db.query(await readFile('supabase/migrations/20260909150000_balance_payment_recovery.sql','utf8'));
  async function order(total=10000,currency='pln',kind='prodigi',status='pending') {
    return (await db.query('insert into orders(subtotal,total,currency,fulfilment_type,status) values($1,$1,$2,$3,$4) returning id',[total,currency,kind,status])).rows[0].id;
  }
  async function rpc(name,args,client=db) {
    assert.match(name,/^[a-z_]+$/);
    return (await client.query(`select * from ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows[0];
  }
  const source=await order(20000,'pln','giftcard','paid');
  const card=await rpc('issue_gift_card',[source,'TEST-GIFT-ONE']);
  assert.equal(card.balance,20000);
  assert.equal((await rpc('issue_gift_card',[source,'IGNORED-RETRY'])).id,card.id);
  const first=await order(12000);
  await assert.rejects(rpc('reserve_gift_card',[first,card.code,200]),/gift_card_paused/);
  await db.query('update gift_card_settings set spending_enabled=true');
  assert.equal((await rpc('reserve_gift_card',[first,card.code,200])).amount,12000);
  assert.equal((await rpc('reserve_gift_card',[first,card.code,200])).amount,12000);
  const second=await order(10000);
  assert.equal((await rpc('reserve_gift_card',[second,card.code,200])).amount,8000);
  await assert.rejects(rpc('reserve_gift_card',[await order(),card.code,200]),/gift_card_empty/);
  await assert.rejects(rpc('reserve_gift_card',[await order(10000,'eur'),card.code,50]),/gift_card_currency/);
  await assert.rejects(rpc('reserve_gift_card',[await order(10000,'pln','giftcard'),card.code,200]),/gift_card_excluded/);
  await assert.rejects(rpc('release_gift_card',[first,null]),/gift_card_payment_not_canceled/);
  await rpc('settle_gift_card',[first,null,0]);
  await rpc('settle_gift_card',[first,null,0]);
  assert.equal((await db.query('select balance from gift_cards where id=$1',[card.id])).rows[0].balance,8000);
  await db.query("update orders set payment_intent_id='pi_test_second' where id=$1",[second]);
  await assert.rejects(rpc('settle_gift_card',[second,'pi_wrong',2000]),/gift_card_payment_mismatch/);
  await assert.rejects(rpc('settle_gift_card',[second,'pi_test_second',1999]),/gift_card_payment_mismatch/);
  await rpc('settle_gift_card',[second,'pi_test_second',2000]);
  assert.equal((await db.query('select balance from gift_cards where id=$1',[card.id])).rows[0].balance,0);
  const refundId=randomUUID();
  const refund=await rpc('prepare_gift_card_refund',[second,refundId,2500]);
  assert.equal(refund.gift_card_amount,2000); assert.equal(refund.cash_amount,500);
  await assert.rejects(rpc('settle_gift_card_refund',[second,refundId,null]),/cash_refund_not_confirmed/);
  await rpc('settle_gift_card_refund',[second,refundId,'re_partial']);
  await rpc('settle_gift_card_refund',[second,refundId,'re_partial']);
  assert.equal((await db.query('select balance from gift_cards where id=$1',[card.id])).rows[0].balance,2000);
  assert.equal((await db.query('select status from orders where id=$1',[second])).rows[0].status,'paid');
  const restId=randomUUID();
  const rest=await rpc('prepare_gift_card_refund',[second,restId,7500]);
  assert.equal(rest.gift_card_amount,6000); assert.equal(rest.cash_amount,1500);
  await rpc('settle_gift_card_refund',[second,restId,'re_rest']);
  assert.equal((await db.query('select status from orders where id=$1',[second])).rows[0].status,'refunded');
  await assert.rejects(rpc('prepare_gift_card_refund',[second,randomUUID(),1]),/invalid_refund_amount/);
  const tiny=await order(8100);
  assert.equal((await rpc('reserve_gift_card',[tiny,card.code,200])).amount,7900);
  await db.query("update orders set status='expired' where id=$1",[tiny]);
  await rpc('release_gift_card',[tiny,null]); await rpc('release_gift_card',[tiny,null]);
  // Two transactions reserve from the same balance. The second must wait and
  // then see the first hold; no read/compute/write race can overspend it.
  const a=await order(6000);const b=await order(6000);
  const other=cluster.getPgClient();await other.connect();clients.push(other);
  await db.query('begin');
  assert.equal((await rpc('reserve_gift_card',[a,card.code,200])).amount,6000);
  const competing=rpc('reserve_gift_card',[b,card.code,200],other);
  await db.query('commit');
  assert.equal((await competing).amount,2000);
  assert.equal(Number((await db.query("select sum(amount) amount from gift_card_holds where card_id=$1 and status='held'",[card.id])).rows[0].amount),8000);
  assert.equal((await db.query("select count(*)::int n from gift_card_ledger where event_key=$1",['spend:'+first])).rows[0].n,1);
  // Use the actual prepare + inventory RPCs: a failure must leave no order,
  // line item or card hold. A successful retry must keep one snapshot.
  const source2=await order(50000,'eur','giftcard','paid');
  const card2=await rpc('issue_gift_card',[source2,'TEST-EUR-CARD']);
  await db.query("insert into drops values('active','Active','active'),('ended','Ended','ended'); insert into products values('ceramic','ceramic','active','active'),('closed','ceramic','active','ended'); insert into piece_state(product_id,status) values('ceramic','available'),('closed','available')");
  const snapshot={id:randomUUID(),currency:'eur',subtotal:10000,shipping:500,total:10500,fulfilment_type:'inpost',shipping_method:'kurier',delivery_method:'kurier',email:'test@example.invalid',locale:'en'};
  const items=[{product_id:'closed',unit_price:10000,variant:null}];
  async function prepare(s=snapshot,i=items,f='a'.repeat(64)) {
    return (await db.query('select prepare_balance_order($1,$2,$3,$4,50,null) as result',[JSON.stringify(s),JSON.stringify(i),card2.code,f])).rows[0].result;
  }
  await assert.rejects(prepare(),/ceramic_unavailable/);
  assert.equal((await db.query('select count(*)::int n from orders where id=$1',[snapshot.id])).rows[0].n,0);
  items[0].product_id='ceramic';
  assert.equal((await prepare()).gift_card_amount,10500);
  assert.equal((await prepare()).cash_amount,0);
  await assert.rejects(prepare(snapshot,items,'b'.repeat(64)),/order_attempt_conflict/);
  await db.query('update gift_card_settings set spending_enabled=false');
  await rpc('settle_gift_card',[snapshot.id,null,0]); // pause must preserve in-flight payments
  await rpc('settle_gift_card',[snapshot.id,null,0]);
  assert.equal((await db.query("select status from piece_state where product_id='ceramic'")).rows[0].status,'sold');
  assert.equal((await db.query('select count(*)::int n from order_items where order_id=$1',[snapshot.id])).rows[0].n,1);
  await db.query('update gift_card_settings set spending_enabled=true');
  const abandoned={...snapshot,id:randomUUID(),subtotal:50000,total:50500,fulfilment_type:'prodigi'};
  const abandonedItems=[{product_id:'print',unit_price:50000,variant:{kind:'print'}}];
  const prepared=await prepare(abandoned,abandonedItems);
  assert.equal(prepared.cash_amount,11000);
  await rpc('begin_balance_intent',[abandoned.id]);
  await assert.rejects(rpc('abort_balance_order',[abandoned.id,null]),/payment_outcome_unknown/);
  await db.query("update orders set payment_intent_id='pi_external' where id=$1",[abandoned.id]);
  await rpc('settle_gift_card',[abandoned.id,'pi_external',11000]);
  await rpc('reconcile_balance_cash_refund',[abandoned.id,5500]);
  const half=(await db.query('select balance from gift_cards where id=$1',[card2.id])).rows[0].balance;
  assert.equal(half,19750);
  await rpc('reconcile_balance_cash_refund',[abandoned.id,5500]);
  await rpc('reconcile_balance_cash_refund',[abandoned.id,2000]); // out-of-order event
  assert.equal((await db.query('select balance from gift_cards where id=$1',[card2.id])).rows[0].balance,half);
  await rpc('reconcile_balance_cash_refund',[abandoned.id,11000]);
  assert.equal((await db.query('select status from orders where id=$1',[abandoned.id])).rows[0].status,'refunded');
  // An inventory loss cannot consume the card, even after cash has arrived.
  const lost={...snapshot,id:randomUUID()};
  await db.query("update piece_state set status='available',order_id=null where product_id='ceramic'");
  await prepare(lost);
  await db.query("update piece_state set order_id=gen_random_uuid() where product_id='ceramic'");
  await assert.rejects(rpc('settle_gift_card',[lost.id,null,0]),/ceramic_reservation_lost/);
  assert.equal((await db.query('select status from gift_card_holds where order_id=$1',[lost.id])).rows[0].status,'held');
  await rpc('abort_balance_order',[lost.id,null]);
  assert.equal((await db.query('select status from gift_card_holds where order_id=$1',[lost.id])).rows[0].status,'released');
  await db.query(`create table promo_codes(id uuid primary key default gen_random_uuid(),code text,source_order_id uuid,source text,active boolean,expires_at timestamptz,amount_pln integer,amount_eur integer,amount_gbp integer);
    create table promo_redemptions(promo_id uuid,order_id uuid,status text);`);
  const legacyOrders={};
  for(const state of ['unused','spent','revoked','pending']) {
    legacyOrders[state]=await order(10000,'gbp','giftcard','paid');
    const promoId=(await db.query("insert into promo_codes(code,source_order_id,source,active,amount_pln,amount_eur,amount_gbp) values($1,$2,'gift_card',$3,50000,12000,10000) returning id",['LEGACY-'+state.toUpperCase(),legacyOrders[state],state!=='revoked'])).rows[0].id;
    if(state==='spent'||state==='pending') await db.query('insert into promo_redemptions values($1,$2,$3)',[promoId,await order(),state==='spent'?'redeemed':'pending']);
  }
  await db.query(await readFile('supabase/migrations/20260909160000_legacy_gift_card_cutover.sql','utf8'));
  for(const [state,id] of Object.entries(legacyOrders)) {
    const migrated=(await db.query('select * from gift_cards where source_order_id=$1',[id])).rows[0];
    assert.equal(migrated.balance,state==='unused'?10000:0);
    assert.equal(migrated.currency,'gbp');
    if(state==='pending') assert.equal(migrated.status,'review');
    if(state==='revoked') assert.equal(migrated.status,'revoked');
  }
  assert.equal((await db.query('select count(*)::int n from promo_codes where active')).rows[0].n,0);
  await assert.rejects(db.query("update promo_codes set active=true where code='LEGACY-UNUSED'"),/gift_card_balance_required/);
  await assert.rejects(db.query("update promo_codes set source='admin' where code='LEGACY-SPENT'"),/immutable/);
  assert.equal((await rpc('prepare_gift_card_purchase_refund',[source])).prepare_gift_card_purchase_refund,false);
  assert.equal((await rpc('prepare_gift_card_purchase_refund',[legacyOrders.unused])).prepare_gift_card_purchase_refund,true);
  await assert.rejects(rpc('reserve_gift_card',[await order(1000,'gbp'),'LEGACY-UNUSED',30]),/gift_card_invalid/);
  await db.query("update orders set status='refunded' where id=$1",[legacyOrders.unused]);
  assert.equal((await rpc('revoke_refunded_gift_card',[legacyOrders.unused])).revoke_refunded_gift_card,true);
  assert.equal((await db.query('select balance from gift_cards where source_order_id=$1',[legacyOrders.unused])).rows[0].balance,0);
  console.log('PASS: issuance/retry, shipping-inclusive allocation, retained balance, concurrent holds, currency/exclusions, payment matching, cancellation, minimum top-up, partial/full proportional refunds and idempotent ledger.');
} finally {await Promise.all(clients.map(c=>c.end()));await cluster.stop();}
