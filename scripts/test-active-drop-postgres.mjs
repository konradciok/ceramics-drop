// Real PostgreSQL integration check; uses an isolated LOCAL test cluster only.
// Usage: node scripts/test-active-drop-postgres.mjs <embedded-postgres module URL> <new data directory>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const { default: EmbeddedPostgres } = await import(process.argv[2]);
const cluster = new EmbeddedPostgres({
  databaseDir: process.argv[3], user: 'postgres', password: randomUUID(),
  port: 57654, persistent: true, createPostgresUser: false,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog() {}, onError() {},
});
const clients = [];
try {
  await cluster.initialise();
  await cluster.start();
  const db = cluster.getPgClient();
  await db.connect(); clients.push(db);
  await db.query(`
    create role anon; create role authenticated; create role service_role;
    create table drops(id text primary key,label text,status text);
    create table products(id text primary key,type text,status text,drop_id text references drops(id));
    create table piece_state(product_id text primary key,status text,showroom boolean default false,reserved_until timestamptz,order_id uuid);
    create table private_sales(id uuid primary key default gen_random_uuid(),token text,product_ids text[],consumed_at timestamptz,expires_at timestamptz);
    create table orders(private_sale_id uuid,status text);
  `);
  // Execute the actual pre-migration reservation implementations.
  const legacy = await readFile('supabase/migrations/20260813170000_harden_rpc_and_catalog.sql', 'utf8');
  const from = legacy.indexOf('create or replace function reserve_pieces(');
  const to = legacy.indexOf('-- =============================================================================', from);
  await db.query(legacy.slice(from, to));
  await db.query(await readFile('supabase/migrations/20260909120000_active_drop_purchase_guard.sql', 'utf8'));
  await db.query(`insert into drops values ('active','Active','active'),('ended','Ended','ended');`);
  async function piece(id, drop = 'active', status = 'available', catalog = 'active') {
    await db.query('insert into products values ($1,\'ceramic\',$2,$3)', [id, catalog, drop]);
    await db.query('insert into piece_state(product_id,status) values ($1,$2)', [id, status]);
  }
  async function reserve(id, order = randomUUID(), client = db) {
    return (await client.query('select reserve_pieces($1,$2,900) as conflicts', [[id], order])).rows[0].conflicts;
  }
  await piece('normal');
  const owner = randomUUID();
  assert.deepEqual(await reserve('normal', owner), []);
  assert.deepEqual(await reserve('normal', owner), []);
  assert.deepEqual(await reserve('normal'), ['normal']);
  await piece('ended', 'ended'); assert.deepEqual(await reserve('ended'), ['ended']);
  await piece('no-drop', null); assert.deepEqual(await reserve('no-drop'), ['no-drop']);
  await piece('hidden', 'active', 'available', 'hidden'); assert.deepEqual(await reserve('hidden'), ['hidden']);
  await piece('sold', 'active', 'sold'); assert.deepEqual(await reserve('sold'), ['sold']);
  assert.deepEqual(await reserve('missing'), ['missing']);
  await db.query("update drops set status='ended' where id='active'");
  assert.deepEqual(await reserve('normal', owner), []); // Existing live checkout survives.
  await db.query("update piece_state set reserved_until=now()-interval '1 minute' where product_id='normal'");
  assert.deepEqual(await reserve('normal', owner), ['normal']); // Expired hold cannot reopen a drop.
  await db.query("insert into private_sales(token,product_ids,expires_at) values ('private',array['sold'],now()+interval '1 day')");
  assert.deepEqual((await db.query('select reserve_private_sale_pieces($1,$2,$3,900) as conflicts', ['private',['sold'],randomUUID()])).rows[0].conflicts, ['sold']);
  await db.query("update drops set status='active' where id='active'");
  assert.deepEqual((await db.query('select reserve_private_sale_pieces($1,$2,$3,900) as conflicts', ['private',['sold'],randomUUID()])).rows[0].conflicts, []);
  // A concurrent end-drop UPDATE must wait for the reservation transaction.
  await piece('race');
  const other = cluster.getPgClient(); await other.connect(); clients.push(other);
  await db.query('begin');
  assert.deepEqual(await reserve('race'), []);
  await other.query('begin'); await other.query("set local lock_timeout='150ms'");
  await assert.rejects(other.query("update drops set status='ended' where id='active'"), (e) => e.code === '55P03');
  await other.query('rollback'); await db.query('commit');
  await other.query("update drops set status='ended' where id='active'");
  await piece('after-close'); assert.deepEqual(await reserve('after-close'), ['after-close']);
  for (const role of ['anon','authenticated','service_role']) {
    assert.equal((await db.query("select has_function_privilege($1,'reserve_pieces_inventory_v1(text[],uuid,integer)','execute') as allowed", [role])).rows[0].allowed, false);
  }
  console.log('PASS: active/ended/missing drop; hidden/sold/missing piece; idempotency; live/expired holds; private sales; concurrent close; helper privileges.');
} finally {
  await Promise.all(clients.map((db) => db.end()));
  await cluster.stop();
}
