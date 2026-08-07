'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DataTable, type Column } from '@/components/admin/DataTable';
import type { ProductListRow } from '@/lib/admin/catalog-list';
import type { ProductDisplayStatus } from '@/lib/catalog/status';
import type { CategorySlug } from '@/lib/types';

/** PL label + reused pill colour class per display status. */
const STATUS_META: Record<ProductDisplayStatus, { label: string; pill: string }> = {
  active: { label: 'Aktywny', pill: 'available' },
  reserved: { label: 'Rezerwacja', pill: 'reserved' },
  showroom: { label: 'Showroom', pill: 'showroom' },
  sold: { label: 'Sprzedany', pill: 'sold' },
  out_of_stock: { label: 'Brak stanu', pill: 'expired' },
  draft: { label: 'Szkic', pill: 'pending' },
  hidden: { label: 'Ukryty', pill: 'expired' },
  archived: { label: 'Archiwum', pill: 'expired' },
};

/** KPI tiles that partition every product (counts sum to rows.length). */
const KPI_TILES: { label: string; statuses: ProductDisplayStatus[] }[] = [
  { label: 'Aktywne', statuses: ['active'] },
  { label: 'Rezerwacje', statuses: ['reserved'] },
  { label: 'Sprzedane', statuses: ['sold'] },
  { label: 'Showroom', statuses: ['showroom'] },
  { label: 'Brak stanu', statuses: ['out_of_stock'] },
  { label: 'Szkice', statuses: ['draft'] },
  { label: 'Ukryte / archiwum', statuses: ['hidden', 'archived'] },
];

type TypeFilter = 'all' | 'ceramic' | 'print';
type SortKey = 'category' | 'status' | 'price';

/** Set equality for status arrays (order-independent). */
function sameStatuses(a: ProductDisplayStatus[] | null, b: ProductDisplayStatus[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

export function ProductsTable({ rows }: { rows: ProductListRow[] }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [statuses, setStatuses] = useState<ProductDisplayStatus[] | null>(null);
  const [category, setCategory] = useState<CategorySlug | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('category');

  // KPI counts computed client-side from the full rows set.
  const counts = useMemo(() => {
    const c = {} as Record<ProductDisplayStatus, number>;
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const tally = (ss: ProductDisplayStatus[]) => ss.reduce((n, s) => n + (counts[s] ?? 0), 0);

  // Category chips derived from the data, preserving server row order.
  const categoriesPresent = useMemo(() => {
    const seen = new Map<CategorySlug, string>();
    for (const r of rows) {
      if (!seen.has(r.category)) seen.set(r.category, r.categoryLabel);
    }
    return [...seen.entries()].map(([slug, label]) => ({ slug, label }));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (statuses && !statuses.includes(r.status)) return false;
      if (category !== 'all' && r.category !== category) return false;
      if (q && !(`${r.id} ${r.num} ${r.title} ${r.categoryLabel}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (sort === 'status') out.sort((a, b) => a.status.localeCompare(b.status));
    else if (sort === 'price') out.sort((a, b) => a.priceValue - b.priceValue);
    // 'category' keeps the server order (category → num).
    return out;
  }, [rows, query, type, statuses, category, sort]);

  function toggleStatuses(ss: ProductDisplayStatus[]) {
    setStatuses((prev) => (sameStatuses(prev, ss) ? null : ss));
  }

  return (
    <>
      {/* KPI tiles — double as quick-filter shortcuts */}
      <div className="adm-kpis adm-kpis--tight" role="group" aria-label="Filtruj po statusie">
        {KPI_TILES.map((tile) => {
          const count = tally(tile.statuses);
          const active = sameStatuses(statuses, tile.statuses);
          const disabled = count === 0 && !active;
          return (
            <button
              type="button"
              key={tile.label}
              className={`adm-kpi ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => toggleStatuses(tile.statuses)}
            >
              <p className="adm-kpi-label">{tile.label}</p>
              <div className="adm-kpi-value">{count}</div>
            </button>
          );
        })}
      </div>

      <div className="adm-toolbar">
        <input
          className="adm-search"
          type="search"
          placeholder="Szukaj: id, numer, nazwa, kategoria…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Szukaj produktów"
        />
        <button type="button" aria-pressed={type === 'all'} className={`adm-chip ${type === 'all' ? 'is-active' : ''}`} onClick={() => setType('all')}>Wszystkie</button>
        <button type="button" aria-pressed={type === 'ceramic'} className={`adm-chip ${type === 'ceramic' ? 'is-active' : ''}`} onClick={() => setType('ceramic')}>Ceramika</button>
        <button type="button" aria-pressed={type === 'print'} className={`adm-chip ${type === 'print' ? 'is-active' : ''}`} onClick={() => setType('print')}>Druki</button>
        <select className="adm-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sortowanie">
          <option value="category">Sortuj: kategoria</option>
          <option value="status">Sortuj: status</option>
          <option value="price">Sortuj: cena</option>
        </select>
      </div>

      {categoriesPresent.length > 1 && (
        <div className="adm-toolbar">
          <button type="button" aria-pressed={category === 'all'} className={`adm-chip ${category === 'all' ? 'is-active' : ''}`} onClick={() => setCategory('all')}>
            Wszystkie kategorie
          </button>
          {categoriesPresent.map(({ slug, label }) => (
            <button
              type="button"
              key={slug}
              aria-pressed={category === slug}
              className={`adm-chip ${category === slug ? 'is-active' : ''}`}
              onClick={() => setCategory(slug)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {filtered.length !== rows.length && (
        <p className="adm-sub adm-sub--tight" style={{ marginBottom: 12 }}>
          Pokazuję {filtered.length} z {rows.length}
        </p>
      )}

      <DataTable
        columns={COLUMNS}
        rows={filtered}
        getRowKey={(r) => r.id}
        empty="Brak produktów pasujących do filtrów."
      />
    </>
  );
}

const COLUMNS: Column<ProductListRow>[] = [
  {
    key: 'product',
    header: 'Produkt',
    render: (r) => (
      <Link className="adm-item" href={`/admin/products/${r.id}`}>
        {r.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.image} alt="" />
        ) : (
          <div className="adm-item-noimg" />
        )}
        <div className="adm-item-meta">
          <div>{r.title}</div>
          <div className="id">{r.id}</div>
        </div>
      </Link>
    ),
  },
  { key: 'category', header: 'Kategoria', render: (r) => r.categoryLabel },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className={`adm-pill ${STATUS_META[r.status].pill}`}>{STATUS_META[r.status].label}</span>
    ),
  },
  { key: 'stock', header: 'Magazyn', render: (r) => r.stockLabel },
  { key: 'variants', header: 'Warianty', render: (r) => r.variantCount },
  { key: 'price', header: 'Cena', render: (r) => r.priceLabel },
];
