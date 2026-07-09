'use client';

import { useMemo, useState } from 'react';
import type { ProductListRow } from '@/lib/admin/catalog-list';
import type { ProductDisplayStatus } from '@/lib/catalog/status';

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

type TypeFilter = 'all' | 'ceramic' | 'print';
type SortKey = 'category' | 'status' | 'price';

export function ProductsTable({ rows }: { rows: ProductListRow[] }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<ProductDisplayStatus | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('category');

  // Only offer status chips that actually occur in the data.
  const statusesPresent = useMemo(() => {
    const set = new Set<ProductDisplayStatus>();
    for (const r of rows) set.add(r.status);
    return [...set];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (status !== 'all' && r.status !== status) return false;
      if (q && !(`${r.id} ${r.num} ${r.title}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (sort === 'status') out.sort((a, b) => a.status.localeCompare(b.status));
    else if (sort === 'price') out.sort((a, b) => a.priceValue - b.priceValue);
    // 'category' keeps the server order (category → num).
    return out;
  }, [rows, query, type, status, sort]);

  return (
    <>
      <div className="adm-toolbar">
        <input
          className="adm-search"
          type="search"
          placeholder="Szukaj: id, numer, nazwa…"
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

      <div className="adm-toolbar">
        <button type="button" aria-pressed={status === 'all'} className={`adm-chip ${status === 'all' ? 'is-active' : ''}`} onClick={() => setStatus('all')}>Każdy status</button>
        {statusesPresent.map((s) => (
          <button type="button" key={s} aria-pressed={status === s} className={`adm-chip ${status === s ? 'is-active' : ''}`} onClick={() => setStatus(s)}>
            {STATUS_META[s].label}
          </button>
        ))}
      </div>

      <div className="adm-tablewrap">
        <table className="adm-table adm-table--stack">
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Kategoria</th>
              <th>Status</th>
              <th>Magazyn</th>
              <th>Warianty</th>
              <th>Cena</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td data-label="Produkt">
                  <div className="adm-item">
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
                  </div>
                </td>
                <td data-label="Kategoria">{r.categoryLabel}</td>
                <td data-label="Status"><span className={`adm-pill ${STATUS_META[r.status].pill}`}>{STATUS_META[r.status].label}</span></td>
                <td data-label="Magazyn">{r.stockLabel}</td>
                <td data-label="Warianty">{r.variantCount}</td>
                <td data-label="Cena">{r.priceLabel}</td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="adm-empty">Brak produktów pasujących do filtrów.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
