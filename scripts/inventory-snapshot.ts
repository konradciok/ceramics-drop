/**
 * Snapshot or restore piece_state rows for selected categories.
 *
 * Usage:
 *   npx tsx scripts/inventory-snapshot.ts snapshot --categories duze-michy,wazony-duze,...
 *   npx tsx scripts/inventory-snapshot.ts restore --file docs/inventory-snapshots/<file>.json
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { isAvailable, type PieceRow } from '../src/lib/inventory';
import { CATEGORIES, getProductsByCategory } from '../src/lib/products';
import type { CategorySlug } from '../src/lib/types';

const DEFAULT_CATEGORIES: CategorySlug[] = [
  'duze-michy',
  'wazony-duze',
  'wazony-srednie',
  'talerze-duze',
  'miski-falowane',
];

type SnapshotPiece = {
  product_id: string;
  category: CategorySlug;
  num: string;
  status: PieceRow['status'];
  reserved_until: string | null;
  order_id: string | null;
  available: boolean;
};

type SnapshotFile = {
  snapshotAt: string;
  label: string;
  categories: CategorySlug[];
  summary: Record<
    CategorySlug,
    { total: number; available: number; reserved: number; sold: number }
  >;
  pieces: SnapshotPiece[];
};

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadLocalEnv(): Record<string, string | undefined> {
  return {
    ...parseEnvFile('.env.local'),
    ...parseEnvFile('.dev.vars'),
    ...process.env,
  };
}

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  return undefined;
}

function getSupabase() {
  const env = loadLocalEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local / .dev.vars / env.');
  }
  return createClient(url, key);
}

function parseCategories(raw: string | undefined): CategorySlug[] {
  if (!raw) return DEFAULT_CATEGORIES;
  return raw.split(',').map((s) => s.trim()) as CategorySlug[];
}

const CATEGORY_PL: Record<CategorySlug, string> = {
  kubki: 'Kubki',
  wazony: 'Wazony',
  'wazony-srednie': 'Średnie wazony',
  'wazony-duze': 'Duże wazony',
  talerzyki: 'Talerzyki',
  'talerze-srednie': 'Średnie talerze',
  'talerze-duze': 'Duże talerze',
  'duze-michy': 'Duże misy',
  'miski-falowane': 'Miski z falowanym brzegiem',
  'fine-art-prints': 'Grafiki fine art',
};

function categoryLabel(slug: CategorySlug): string {
  return CATEGORY_PL[slug] ?? slug;
}

function buildSummary(
  pieces: SnapshotPiece[],
  categories: CategorySlug[],
): SnapshotFile['summary'] {
  const summary = {} as SnapshotFile['summary'];
  for (const slug of categories) {
    summary[slug] = { total: 0, available: 0, reserved: 0, sold: 0 };
  }
  for (const piece of pieces) {
    const row = summary[piece.category] ?? { total: 0, available: 0, reserved: 0, sold: 0 };
    row.total += 1;
    if (piece.status === 'sold') row.sold += 1;
    else if (piece.status === 'reserved') row.reserved += 1;
    if (piece.available) row.available += 1;
    summary[piece.category] = row;
  }
  return summary;
}

function renderMarkdown(snapshot: SnapshotFile): string {
  const lines: string[] = [
    `# Inventory snapshot — ${snapshot.label}`,
    '',
    `- **Captured at:** ${snapshot.snapshotAt}`,
    `- **Categories:** ${snapshot.categories.join(', ')}`,
    `- **Restore:** \`npx tsx scripts/inventory-snapshot.ts restore --file docs/inventory-snapshots/${snapshot.label}.json\``,
    '',
    '## Summary',
    '',
    '| Category | PL name | Total | Available | Reserved | Sold |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];

  for (const slug of snapshot.categories) {
    const s = snapshot.summary[slug];
    lines.push(
      `| \`${slug}\` | ${categoryLabel(slug)} | ${s.total} | ${s.available} | ${s.reserved} | ${s.sold} |`,
    );
  }

  lines.push('', '## Pieces', '');

  for (const slug of snapshot.categories) {
    const catPieces = snapshot.pieces.filter((p) => p.category === slug);
    lines.push(`### ${slug}`, '');
    lines.push('| ID | # | Status | Available | Reserved until | Order |');
    lines.push('| --- | ---: | --- | --- | --- | --- |');
    for (const piece of catPieces) {
      lines.push(
        `| \`${piece.product_id}\` | ${piece.num} | ${piece.status} | ${piece.available ? 'yes' : 'no'} | ${piece.reserved_until ?? '—'} | ${piece.order_id ?? '—'} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function snapshot(): Promise<void> {
  const categories = parseCategories(getArg('--categories'));
  for (const slug of categories) {
    if (!CATEGORIES[slug]) throw new Error(`Unknown category slug: ${slug}`);
  }

  const products = categories.flatMap((slug) =>
    getProductsByCategory(slug).map((p) => ({ id: p.id, category: slug, num: p.num })),
  );
  const ids = products.map((p) => p.id);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('piece_state')
    .select('product_id, status, reserved_until, order_id')
    .in('product_id', ids);
  if (error) throw new Error(`piece_state query failed: ${error.message}`);

  const byId = new Map((data ?? []).map((row) => [row.product_id as string, row]));
  const now = new Date();
  const missing: string[] = [];

  const pieces: SnapshotPiece[] = products.map(({ id, category, num }) => {
    const row = byId.get(id);
    if (!row) {
      missing.push(id);
      return {
        product_id: id,
        category,
        num,
        status: 'available' as const,
        reserved_until: null,
        order_id: null,
        available: true,
      };
    }
    const pieceRow: PieceRow = {
      status: row.status as PieceRow['status'],
      reserved_until: row.reserved_until as string | null,
    };
    return {
      product_id: id,
      category,
      num,
      status: pieceRow.status,
      reserved_until: pieceRow.reserved_until,
      order_id: (row.order_id as string | null) ?? null,
      available: isAvailable(pieceRow, now),
    };
  });

  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} product(s) missing from piece_state (assumed available): ${missing.join(', ')}`);
  }

  const snapshotAt = new Date().toISOString();
  const date = snapshotAt.slice(0, 10);
  const label = `${date}-five-categories`;
  const payload: SnapshotFile = {
    snapshotAt,
    label,
    categories,
    summary: buildSummary(pieces, categories),
    pieces,
  };

  const outDir = path.join('docs', 'inventory-snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${label}.json`);
  const mdPath = path.join(outDir, `${label}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(mdPath, `${renderMarkdown(payload)}\n`);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log('');
  for (const slug of categories) {
    const s = payload.summary[slug];
    console.log(`${slug}: ${s.available}/${s.total} available (${s.sold} sold, ${s.reserved} reserved)`);
  }
}

async function restore(): Promise<void> {
  const file = getArg('--file');
  if (!file) throw new Error('restore requires --file docs/inventory-snapshots/<file>.json');

  const raw = fs.readFileSync(file, 'utf8');
  const snapshot = JSON.parse(raw) as SnapshotFile;
  const supabase = getSupabase();

  for (const piece of snapshot.pieces) {
    const { error } = await supabase
      .from('piece_state')
      .upsert(
        {
          product_id: piece.product_id,
          status: piece.status,
          reserved_until: piece.reserved_until,
          order_id: piece.order_id,
        },
        { onConflict: 'product_id' },
      );
    if (error) throw new Error(`restore failed for ${piece.product_id}: ${error.message}`);
  }

  console.log(`Restored ${snapshot.pieces.length} piece(s) from ${file}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'snapshot') {
    await snapshot();
    return;
  }
  if (command === 'restore') {
    await restore();
    return;
  }
  throw new Error('Usage: inventory-snapshot.ts snapshot|restore [--categories a,b] [--file path]');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
