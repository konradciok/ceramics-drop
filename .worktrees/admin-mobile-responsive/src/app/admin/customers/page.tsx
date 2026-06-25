import Link from 'next/link';
import { listCustomers } from '@/lib/admin/data';
import { formatMoney } from '@/lib/admin/money';
import { formatDateTime, PhoneLink } from '../ui';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const customers = await listCustomers();

  return (
    <>
      <h1 className="adm-h1">Klienci</h1>
      <p className="adm-sub">{customers.length} {customers.length === 1 ? 'klient' : 'klientów'} · pogrupowani wg adresu e-mail z zamówień.</p>

      <div className="adm-tablewrap">
        {customers.length === 0 ? (
          <div className="adm-empty">Brak klientów.</div>
        ) : (
          <table className="adm-table adm-table--stack">
            <thead>
              <tr>
                <th>Klient</th><th>E-mail</th><th>Telefon</th><th>Zamówienia</th>
                <th>Wydane (opłacone)</th><th>Ostatnie</th><th>Język</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.email}>
                  <td data-label="Klient">{c.name ?? <span className="adm-muted">—</span>}</td>
                  <td data-label="E-mail">
                    {c.emailKnown ? (
                      <Link href={`/admin/orders?email=${encodeURIComponent(c.email)}`}>{c.email}</Link>
                    ) : (
                      <span className="adm-muted">{c.email}</span>
                    )}
                  </td>
                  <td data-label="Telefon"><PhoneLink phone={c.phone} /></td>
                  <td className="adm-num" data-label="Zamówienia">{c.orders}{c.paidOrders !== c.orders ? <span className="adm-muted"> ({c.paidOrders} opł.)</span> : null}</td>
                  <td className="adm-num" data-label="Wydane (opłacone)">
                    {Object.keys(c.spendByCurrency).length === 0
                      ? <span className="adm-muted">—</span>
                      : Object.entries(c.spendByCurrency).map(([cur, v], i) => (
                          <span key={cur}>{i > 0 ? ' + ' : ''}{formatMoney(v, cur)}</span>
                        ))}
                  </td>
                  <td className="adm-num" data-label="Ostatnie">{formatDateTime(c.lastOrderAt)}</td>
                  <td data-label="Język">{c.locale ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
