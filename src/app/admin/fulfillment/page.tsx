import Link from 'next/link';
import { listFulfillmentQueue, type FulfillmentOrder } from '@/lib/admin/fulfillment';
import { formatDateTime, PhoneLink, shortId } from '../ui';
import { FulfillmentActions } from './FulfillmentActions';
import { packingCell } from '../packing-ui';

export const dynamic = 'force-dynamic';

type Method = 'paczkomat' | 'kurier' | 'odbior';
type SearchParams = Promise<{ method?: string }>;

const METHODS: Array<{ value: Method; label: string }> = [
  { value: 'paczkomat', label: 'Paczkomat' },
  { value: 'kurier', label: 'Kurier' },
  { value: 'odbior', label: 'Odbiór osobisty' },
];

const STAGE_LABEL: Record<FulfillmentOrder['stage'], string> = {
  blocked: 'Zablokowane',
  ready: 'Do zapakowania',
  in_transit: 'W drodze',
  pickup: 'Odbiór osobisty',
};

function isMethod(method: string | undefined): method is Method {
  return method === 'paczkomat' || method === 'kurier' || method === 'odbior';
}

function customerName(order: FulfillmentOrder): string {
  return [order.receiver_first_name, order.receiver_last_name].filter(Boolean).join(' ') || '—';
}

function deliveryLine(order: FulfillmentOrder): string {
  if (order.delivery_method === 'paczkomat') return order.inpost_target_point ?? '—';
  if (order.delivery_method === 'odbior') return 'Studio / odbiór osobisty';
  const addr = order.shipping_address as
    | { street?: string; building_number?: string; city?: string; post_code?: string; country_code?: string }
    | null;
  if (!addr) return '—';
  return [[addr.street, addr.building_number].filter(Boolean).join(' '), `${addr.post_code ?? ''} ${addr.city ?? ''}`.trim(), addr.country_code]
    .filter(Boolean)
    .join(', ');
}

export default async function FulfillmentPage({ searchParams }: { searchParams: SearchParams }) {
  const { method } = await searchParams;
  const activeMethod = isMethod(method) ? method : 'paczkomat';
  const queue = await listFulfillmentQueue();
  const grouped = Object.fromEntries(METHODS.map((m) => [m.value, queue.filter((order) => order.delivery_method === m.value)])) as Record<
    Method,
    FulfillmentOrder[]
  >;
  const activeOrders = grouped[activeMethod];

  return (
    <>
      <h1 className="adm-h1">Wysyłka</h1>
      <p className="adm-sub">{queue.length} {queue.length === 1 ? 'zamówienie' : 'zamówień'} do zapakowania lub odbioru</p>

      {queue.length === 0 ? (
        <div className="adm-tablewrap"><div className="adm-empty">Brak zamówień do wysyłki.</div></div>
      ) : (
        <>
          <div className="adm-toolbar">
            {METHODS.map((m) => (
              <Link key={m.value} href={`/admin/fulfillment?method=${m.value}`} className={`adm-chip ${activeMethod === m.value ? 'is-active' : ''}`}>
                {m.label} <span className="adm-muted">({grouped[m.value].length})</span>
              </Link>
            ))}
          </div>

          <div className="adm-tablewrap">
            {activeOrders.length === 0 ? (
              <div className="adm-empty">Brak zamówień w tej sekcji.</div>
            ) : (
              <table className="adm-table adm-fulfillment-table adm-table--stack">
                <thead>
                  <tr>
                    <th>Zamówienie</th>
                    <th>Opłacone</th>
                    <th>Prace</th>
                    <th>Klient</th>
                    <th>Dostawa</th>
                    <th>Paczka</th>
                    <th>Status</th>
                    <th>Akcja</th>
                  </tr>
                </thead>
                <tbody>
                  {activeOrders.map((order) => (
                    <tr key={order.id}>
                      <td data-label="Zamówienie"><Link className="adm-mono" href={`/admin/fulfillment/${order.id}`}>{shortId(order.id)}</Link></td>
                      <td className="adm-num" data-label="Opłacone">{formatDateTime(order.paid_at ?? order.created_at)}</td>
                      <td data-label="Prace">
                        <div className="adm-queue-pieces">
                          <div className="adm-queue-thumbs">
                            {order.itemsEnriched.slice(0, 4).map((item) => (
                              item.ref.image
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <img key={item.product_id} src={item.ref.image} alt="" />
                                : <span key={item.product_id} className="adm-queue-noimg" />
                            ))}
                          </div>
                          <div>
                            {order.itemsEnriched.map((item) => item.ref.label).join(', ')}
                            <div className="adm-muted adm-mono">{order.itemsEnriched.map((item) => item.product_id).join(', ')}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Klient">
                        <div>{customerName(order)}</div>
                        <PhoneLink phone={order.receiver_phone} />
                      </td>
                      <td data-label="Dostawa">{deliveryLine(order)}</td>
                      <td data-label="Paczka">{packingCell(order.delivery_method, order.items.map((it) => it.product_id))}</td>
                      <td data-label="Status"><span className={`adm-pill ${order.stage}`}>{STAGE_LABEL[order.stage]}</span></td>
                      <td data-label="Akcja"><FulfillmentActions orderId={order.id} stage={order.stage} compact /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
