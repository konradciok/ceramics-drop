import { listInventory, listDrops, listInterest } from '@/lib/admin/data';
import { productRef } from '@/lib/admin/products';
import { registryProductById } from '@/lib/products';
import { formatDateTime } from '../ui';
import { InventoryManager, type InventoryRow, type DropInfo } from './InventoryManager';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const [pieces, drops, interest] = await Promise.all([listInventory(), listDrops(), listInterest()]);

  const counts = { available: 0, reserved: 0, sold: 0, showroom: 0 };
  for (const p of pieces) {
    counts[p.status] += 1;
    if (p.showroom) counts.showroom += 1;
  }

  // Group interest submissions by product for the per-row expandable list.
  const interestByProduct = new Map<string, InventoryRow['interest']>();
  for (const it of interest) {
    const list = interestByProduct.get(it.product_id) ?? [];
    list.push({
      email: it.email,
      message: it.message,
      consent: it.consent_marketing,
      createdAt: formatDateTime(it.created_at),
    });
    interestByProduct.set(it.product_id, list);
  }

  const rows: InventoryRow[] = pieces.map((p) => {
    const ref = productRef(p.product_id);
    return {
      productId: p.product_id,
      label: ref.label,
      known: ref.known,
      status: p.status,
      showroom: p.showroom,
      // Drop membership is a static, code-owned fact on the product registry.
      dropId: registryProductById(p.product_id)?.dropId ?? null,
      reservedUntilLabel: p.reserved_until ? formatDateTime(p.reserved_until) : '—',
      reservedExpired: p.reservedExpired,
      orderId: p.order_id,
      interest: interestByProduct.get(p.product_id) ?? [],
    };
  });

  const dropInfos: DropInfo[] = drops.map((d) => ({ id: d.id, label: d.label, status: d.status }));

  return (
    <>
      <h1 className="adm-h1">Magazyn</h1>
      <p className="adm-sub">{pieces.length} prac · stan rezerwacji, sprzedaży i showroomu (źródło prawdy dla dostępności).</p>

      <div className="adm-kpis adm-kpis--tight">
        <div className="adm-kpi"><p className="adm-kpi-label">Dostępne</p><div className="adm-kpi-value">{counts.available}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Zarezerwowane</p><div className="adm-kpi-value">{counts.reserved}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Sprzedane</p><div className="adm-kpi-value">{counts.sold}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Showroom</p><div className="adm-kpi-value">{counts.showroom}</div></div>
      </div>

      <InventoryManager rows={rows} drops={dropInfos} />
    </>
  );
}
