import Link from 'next/link';
import { listOrders, ORDER_STATUSES, type OrderStatus } from '@/lib/admin/data';
import { formatMoney } from '@/lib/admin/money';
import { formatDateTime, StatusPill, shortId, deliveryLabel, ClientContact } from '../ui';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ status?: string; q?: string; email?: string }>;

function isStatus(s: string | undefined): s is OrderStatus {
  return !!s && (ORDER_STATUSES as string[]).includes(s);
}

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const { status, q, email } = await searchParams;
  const activeStatus = isStatus(status) ? status : undefined;

  let orders = await listOrders({ status: activeStatus, email });

  const query = q?.trim().toLowerCase();
  if (query) {
    orders = orders.filter((o) =>
      [o.id, o.email, o.receiver_first_name, o.receiver_last_name, o.receiver_phone, o.payment_intent_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(query)),
    );
  }

  const chip = (label: string, s?: OrderStatus) => {
    const params = new URLSearchParams();
    if (s) params.set('status', s);
    if (q) params.set('q', q);
    const href = `/admin/orders${params.toString() ? `?${params}` : ''}`;
    const active = activeStatus === s;
    return (
      <Link key={label} href={href} className={`adm-chip ${active ? 'is-active' : ''}`}>
        {label}
      </Link>
    );
  };

  return (
    <>
      <h1 className="adm-h1">Zamówienia</h1>
      <p className="adm-sub">{orders.length} {orders.length === 1 ? 'zamówienie' : 'zamówień'}{email ? ` · ${email}` : ''}</p>

      <div className="adm-toolbar">
        {chip('Wszystkie', undefined)}
        {ORDER_STATUSES.map((s) => chip(s, s))}
        <form className="adm-search" method="get" style={{ padding: 0, border: 'none', marginLeft: 'auto' }}>
          {activeStatus ? <input type="hidden" name="status" value={activeStatus} /> : null}
          <input className="adm-search" type="search" name="q" defaultValue={q ?? ''} placeholder="Szukaj: e-mail, telefon, ID, nazwisko…" />
        </form>
      </div>

      <div className="adm-tablewrap">
        {orders.length === 0 ? (
          <div className="adm-empty">Brak zamówień dla wybranych filtrów.</div>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Data</th><th>Zamówienie</th><th>Status</th><th>Klient</th>
                <th>Kwota</th><th>Dostawa</th><th>Wysyłka</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="adm-num">{formatDateTime(o.created_at)}</td>
                  <td><Link className="adm-mono" href={`/admin/orders/${o.id}`}>{shortId(o.id)}</Link></td>
                  <td><StatusPill status={o.status} /></td>
                  <td><ClientContact email={o.email} phone={o.receiver_phone} /></td>
                  <td className="adm-num">{formatMoney(o.total, o.currency)}</td>
                  <td>{deliveryLabel(o.delivery_method)}</td>
                  <td className="adm-muted">{o.delivery_status ?? (o.delivery_method === 'odbior' ? '—' : 'oczekuje')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
