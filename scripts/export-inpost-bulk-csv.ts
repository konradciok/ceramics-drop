/**
 * Export paid ceramic orders to InPost bulk-upload CSV (semicolon-separated).
 *
 * Usage:
 *   npx tsx scripts/export-inpost-bulk-csv.ts
 *   npx tsx scripts/export-inpost-bulk-csv.ts --output exports/inpost.csv
 *   npx tsx scripts/export-inpost-bulk-csv.ts --include-shipped
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars).
 * Prefers ADMIN_SUPABASE_* when set (mirrors local admin panel).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { recommendPacking } from '../src/lib/packing';
import type { DeliveryAddress } from '../src/lib/shipx';
import { loadLocalEnv } from './lib/script-env';

const HEADERS = [
  'e-mail',
  'telefon',
  'rozmiar',
  'paczkomat',
  'numer_referencyjny',
  'dodatkowa_ochrona',
  'za_pobraniem',
  'imie_i_nazwisko',
  'nazwa_firmy',
  'ulica',
  'kod_pocztowy',
  'miejscowosc',
  'typ_przesylki',
  'paczka_w_weekend',
] as const;

type OrderRow = {
  id: string;
  status: string;
  email: string | null;
  delivery_method: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  inpost_target_point: string | null;
  inpost_shipment_id: string | null;
  shipping_address: DeliveryAddress | null;
  order_items: Array<{ product_id: string; variant: unknown | null }> | null;
};

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function str(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function csvCell(value: string): string {
  if (value.includes(';') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function isPrintOnly(items: OrderRow['order_items']): boolean {
  const lines = items ?? [];
  return lines.length > 0 && lines.every((it) => it.variant != null);
}

function ceramicProductIds(items: OrderRow['order_items']): string[] {
  return (items ?? []).filter((it) => it.variant == null).map((it) => it.product_id);
}

function fullName(order: OrderRow): string {
  return [str(order.receiver_first_name), str(order.receiver_last_name)].filter(Boolean).join(' ');
}

function normalizePhone(phone: string): string {
  const p = phone.trim();
  if (!p) return '';
  if (p.startsWith('+')) return p;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 9) return `+48${digits}`;
  return p;
}

function streetLine(address: DeliveryAddress | null): string {
  if (!address) return '';
  const street = str(address.street);
  const building = str(address.building_number);
  if (!street) return building;
  if (!building) return street;
  if (street === building || street.endsWith(` ${building}`)) return street;
  return `${street} ${building}`;
}

function orderReference(orderId: string, parcelIndex: number, parcelCount: number): string {
  if (parcelCount <= 1) return orderId;
  return `${orderId}#${parcelIndex + 1}`;
}

function rowForParcel(order: OrderRow, size: string, parcelIndex: number, parcelCount: number): string[] {
  const method = order.delivery_method;
  const isPaczkomat = method === 'paczkomat';
  const isKurier = method === 'kurier';
  const address = order.shipping_address;

  return [
    str(order.email),
    normalizePhone(str(order.receiver_phone)),
    size,
    isPaczkomat ? str(order.inpost_target_point) : '',
    orderReference(order.id, parcelIndex, parcelCount),
    '', // dodatkowa_ochrona
    '', // za_pobraniem (prepaid via Stripe)
    isKurier ? fullName(order) : '',
    '', // nazwa_firmy
    isKurier ? streetLine(address) : '',
    isKurier ? str(address?.post_code) : '',
    isKurier ? str(address?.city) : '',
    isPaczkomat ? 'paczkomat' : 'kurier',
    isPaczkomat ? 'NIE' : '',
  ];
}

async function main(): Promise<void> {
  const env = loadLocalEnv();
  const url = env.ADMIN_SUPABASE_URL ?? env.SUPABASE_URL;
  const key = env.ADMIN_SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or ADMIN_* overrides).');
    process.exit(1);
  }

  const includeShipped = hasFlag('include-shipped');
  const outputArg = getArg('output');
  const today = new Date().toISOString().slice(0, 10);
  const outputPath = outputArg ?? path.join('exports', `inpost-bulk-${today}.csv`);

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, status, email, delivery_method, receiver_first_name, receiver_last_name, receiver_phone, inpost_target_point, inpost_shipment_id, shipping_address, order_items(product_id, variant)',
    )
    .eq('status', 'paid')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Supabase query failed:', error.message);
    process.exit(1);
  }

  const orders = (data as OrderRow[] | null) ?? [];
  const rows: string[][] = [];

  for (const order of orders) {
    if (isPrintOnly(order.order_items)) continue;
    const method = order.delivery_method;
    if (method !== 'paczkomat' && method !== 'kurier') continue;
    if (!includeShipped && order.inpost_shipment_id) continue;

    const productIds = ceramicProductIds(order.order_items);
    if (productIds.length === 0) continue;

    const packing = recommendPacking(productIds);
    const packages = packing.packages.length > 0 ? packing.packages : [{ size: 'B' as const }];
    const parcelCount = packages.length;

    packages.forEach((parcel, index) => {
      rows.push(rowForParcel(order, parcel.size, index, parcelCount));
    });
  }

  const lines = [
    HEADERS.join(';'),
    ...rows.map((cells) => cells.map(csvCell).join(';')),
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`Wrote ${rows.length} shipment row(s) from ${orders.length} paid order(s) → ${outputPath}`);
  if (rows.length === 0) {
    console.log('No ceramic paczkomat/kurier orders matched (try --include-shipped?).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
