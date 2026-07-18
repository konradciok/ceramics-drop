#!/usr/bin/env node
/**
 * One-off export: pulls every order (+ line items) from Supabase and writes
 * two CSVs — orders.csv (one row per order) and order-items.csv (one row per
 * line item) — to the given output directory. Ad-hoc reporting tool, not a
 * package.json script; run directly with tsx. Reuses the same env precedence
 * and Supabase client factory as scripts/orders-cli.ts.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listOrders, type AdminOrder } from '../src/lib/admin/data';
import { adminSupabaseFromEnv } from '../src/lib/admin/clients';
import { shippingAddressCsvFields } from '../src/lib/shipping-address';
import { parseEnvText } from './orders-cli';

async function optionalEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function loadEnv(): Promise<Record<string, string | undefined>> {
  const local = await optionalEnvFile(resolve(process.cwd(), '.env.local'));
  const dev = await optionalEnvFile(resolve(process.cwd(), '.dev.vars'));
  return { ...local, ...dev, ...process.env };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c])).join(','));
  return [header, ...body].join('\n') + '\n';
}

function minorToMajor(minor: number, currency: string): string {
  return (minor / 100).toFixed(2) + ' ' + currency.toUpperCase();
}

function addressOf(order: AdminOrder): Record<string, string> {
  return shippingAddressCsvFields(order.shipping_address);
}

const ORDER_COLUMNS = [
  'id',
  'created_at',
  'status',
  'currency',
  'subtotal_display',
  'shipping_display',
  'total_display',
  'items_count',
  'product_ids',
  'email',
  'receiver_first_name',
  'receiver_last_name',
  'receiver_phone',
  'delivery_method',
  'address_street',
  'address_building',
  'address_city',
  'address_postcode',
  'address_country',
  'inpost_target_point',
  'inpost_shipment_id',
  'inpost_tracking_number',
  'delivery_status',
  'locale',
  'paid_at',
  'invoiced_at',
  'invoice_id',
  'customer_notified_at',
  'return_requested_at',
  'payment_intent_id',
  'address_line2',
];

const ITEM_COLUMNS = ['order_id', 'order_created_at', 'order_status', 'product_id', 'unit_price_display', 'currency', 'kind', 'variant'];

async function main(): Promise<void> {
  const outDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolve(process.cwd(), 'exports');
  const env = await loadEnv();
  const url = env.ADMIN_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.ADMIN_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local / .dev.vars / process.env');
    process.exitCode = 3;
    return;
  }
  const supabase = adminSupabaseFromEnv(url, key);
  const orders = await listOrders(undefined, { withItems: true, supabase });

  const orderRows = orders.map((o) => ({
    ...o,
    ...addressOf(o),
    subtotal_display: minorToMajor(o.subtotal, o.currency),
    shipping_display: minorToMajor(o.shipping, o.currency),
    total_display: minorToMajor(o.total, o.currency),
    items_count: o.items.length,
    product_ids: o.items.map((it) => it.product_id).join('; '),
  }));

  const itemRows = orders.flatMap((o) =>
    o.items.map((it) => ({
      order_id: o.id,
      order_created_at: o.created_at,
      order_status: o.status,
      product_id: it.product_id,
      unit_price_display: minorToMajor(it.unit_price, o.currency),
      currency: o.currency,
      kind: it.variant != null ? 'print' : 'ceramic',
      variant: it.variant ?? '',
    })),
  );

  await mkdir(outDir, { recursive: true });
  const ordersPath = resolve(outDir, 'orders.csv');
  const itemsPath = resolve(outDir, 'order-items.csv');
  await writeFile(ordersPath, toCsv(orderRows as unknown as Record<string, unknown>[], ORDER_COLUMNS), 'utf8');
  await writeFile(itemsPath, toCsv(itemRows, ITEM_COLUMNS), 'utf8');

  console.log(`Wrote ${orders.length} orders -> ${ordersPath}`);
  console.log(`Wrote ${itemRows.length} line items -> ${itemsPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
