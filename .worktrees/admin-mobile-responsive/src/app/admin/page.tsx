import Link from 'next/link';
import { getKpis } from '@/lib/admin/data';
import { formatMoney } from '@/lib/admin/money';
import { formatDateTime, StatusPill, shortId, deliveryLabel, ClientContact } from './ui';

export const dynamic = 'force-dynamic';

export default async function AdminOverview() {
  const kpis = await getKpis();
  const pln = kpis.paidRevenue['pln'] ?? 0;
  const eurRevenue = kpis.paidRevenue['eur'];

  return (
    <>
      <h1 className="adm-h1">Przegląd</h1>
      <p className="adm-sub">Sprzedaż, płatności i magazyn w jednym miejscu. Dane na żywo z produkcji.</p>

      <div className="adm-kpis">
        <div className="adm-kpi">
          <p className="adm-kpi-label">Przychód (opłacone)</p>
          <div className="adm-kpi-value">
            {formatMoney(pln, 'pln')}
            {eurRevenue ? <span className="alt">+ {formatMoney(eurRevenue, 'eur')}</span> : null}
          </div>
          <p className="adm-kpi-foot">{kpis.ordersByStatus.paid} opłaconych zamówień</p>
        </div>

        <div className="adm-kpi">
          <p className="adm-kpi-label">Oczekuje wysyłki</p>
          <div className="adm-kpi-value">{kpis.awaitingFulfillment}</div>
          <p className="adm-kpi-foot">opłacone bez przesyłki InPost</p>
        </div>

        <div className="adm-kpi">
          <p className="adm-kpi-label">Sprzedane prace</p>
          <div className="adm-kpi-value">
            {kpis.piecesByStatus.sold}
            <span className="alt">/ {kpis.piecesByStatus.available} dostępnych</span>
          </div>
          <p className="adm-kpi-foot">{kpis.piecesByStatus.reserved} zarezerwowanych</p>
        </div>

        <div className="adm-kpi">
          <p className="adm-kpi-label">Zamówienia wg statusu</p>
          <div className="adm-kpi-value adm-kpi-value--sm">
            {(['paid', 'pending', 'failed', 'expired', 'refunded'] as const)
              .filter((s) => kpis.ordersByStatus[s] > 0)
              .map((s) => (
                <span key={s} className="adm-kpi-status-item">
                  <StatusPill status={s} />
                  {kpis.ordersByStatus[s]}
                </span>
              ))}
          </div>
        </div>
      </div>

      <section className="adm-section">
        <h2 className="adm-section-title">Ostatnie zamówienia</h2>
        {kpis.recent.length === 0 ? (
          <div className="adm-tablewrap"><div className="adm-empty">Brak zamówień.</div></div>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table adm-table--stack">
              <thead>
                <tr>
                  <th>Data</th><th>Zamówienie</th><th>Status</th><th>Klient</th><th>Kwota</th><th>Dostawa</th>
                </tr>
              </thead>
              <tbody>
                {kpis.recent.map((o) => (
                  <tr key={o.id}>
                    <td className="adm-num" data-label="Data">{formatDateTime(o.created_at)}</td>
                    <td data-label="Zamówienie"><Link className="adm-mono" href={`/admin/orders/${o.id}`}>{shortId(o.id)}</Link></td>
                    <td data-label="Status"><StatusPill status={o.status} /></td>
                    <td data-label="Klient"><ClientContact email={o.email} phone={o.receiver_phone} /></td>
                    <td className="adm-num" data-label="Kwota">{formatMoney(o.total, o.currency)}</td>
                    <td data-label="Dostawa">{deliveryLabel(o.delivery_method)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
