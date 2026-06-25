import Link from 'next/link';
import { listInventory } from '@/lib/admin/data';
import { productRef } from '@/lib/admin/products';
import { formatDateTime, StatusPill, shortId } from '../ui';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const pieces = await listInventory();
  const counts = { available: 0, reserved: 0, sold: 0 };
  for (const p of pieces) counts[p.status] += 1;

  return (
    <>
      <h1 className="adm-h1">Magazyn</h1>
      <p className="adm-sub">{pieces.length} prac · stan rezerwacji i sprzedaży (źródło prawdy dla dostępności).</p>

      <div className="adm-kpis adm-kpis--tight">
        <div className="adm-kpi"><p className="adm-kpi-label">Dostępne</p><div className="adm-kpi-value">{counts.available}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Zarezerwowane</p><div className="adm-kpi-value">{counts.reserved}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Sprzedane</p><div className="adm-kpi-value">{counts.sold}</div></div>
      </div>

      <div className="adm-tablewrap">
        <table className="adm-table adm-table--stack">
          <thead>
            <tr><th>Praca</th><th>ID</th><th>Status</th><th>Rezerwacja do</th><th>Zamówienie</th></tr>
          </thead>
          <tbody>
            {pieces.map((p) => {
              const ref = productRef(p.product_id);
              const expired = p.reservedExpired;
              return (
                <tr key={p.product_id}>
                  <td data-label="Praca">{ref.label}{!ref.known && <span className="adm-muted"> (wycofany)</span>}</td>
                  <td className="adm-mono" data-label="ID">{p.product_id}</td>
                  <td data-label="Status"><StatusPill status={p.status} /></td>
                  <td className="adm-num" data-label="Rezerwacja do">
                    {p.reserved_until ? formatDateTime(p.reserved_until) : '—'}
                    {expired ? <span className="adm-text-danger"> · wygasła</span> : null}
                  </td>
                  <td data-label="Zamówienie">{p.order_id ? <Link className="adm-mono" href={`/admin/orders/${p.order_id}`}>{shortId(p.order_id)}</Link> : <span className="adm-muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
