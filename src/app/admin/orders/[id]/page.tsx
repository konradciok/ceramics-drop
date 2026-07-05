import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrder } from '@/lib/admin/data';
import { adminStripe } from '@/lib/admin/clients';
import { productRef } from '@/lib/admin/products';
import { formatMoney } from '@/lib/admin/money';
import { PackingPanel } from '../../packing-ui';
import { formatDateTime, StatusPill, deliveryLabel, shortId, PhoneLink } from '../../ui';
import { OrderActions } from './OrderActions';

export const dynamic = 'force-dynamic';

type PaymentInfo = {
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl: string | null;
  refundedMinor: number;
};

async function loadPayment(paymentIntentId: string | null): Promise<PaymentInfo | null> {
  if (!paymentIntentId) return null;
  try {
    const stripe = adminStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    });
    const charge = (pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null) as
      | { payment_method_details?: { card?: { brand?: string; last4?: string } }; receipt_url?: string | null; amount_refunded?: number }
      | null;
    const card = charge?.payment_method_details?.card;
    return {
      status: pi.status,
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      receiptUrl: charge?.receipt_url ?? null,
      refundedMinor: charge?.amount_refunded ?? 0,
    };
  } catch {
    return null;
  }
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();

  const payment = await loadPayment(order.payment_intent_id);
  const fullyRefunded = payment ? payment.refundedMinor >= order.total : order.status === 'refunded';
  const addr = order.shipping_address as
    | { street?: string; building_number?: string; city?: string; post_code?: string; country_code?: string }
    | null;

  const timeline: { label: string; at: string | null }[] = [
    { label: 'Utworzone', at: order.created_at },
    { label: 'Opłacone', at: order.paid_at },
    { label: 'Faktura', at: order.invoiced_at },
    { label: 'Klient powiadomiony', at: order.customer_notified_at },
    { label: 'Zwrot zgłoszony', at: order.return_requested_at },
  ];

  return (
    <>
      <Link className="adm-back" href="/admin/orders">← Zamówienia</Link>
      <h1 className="adm-h1">
        Zamówienie <span className="adm-mono">{shortId(order.id)}</span>{' '}
        <StatusPill status={order.status} />
      </h1>
      <p className="adm-sub">{formatDateTime(order.created_at)} · {order.items.length} {order.items.length === 1 ? 'pozycja' : 'pozycji'} · {formatMoney(order.total, order.currency)}</p>

      <div className="adm-detail-grid">
        {/* Items */}
        <div className="adm-panel adm-panel--wide">
          <h3>Pozycje</h3>
          {order.items.map((it) => {
            const ref = productRef(it.product_id);
            return (
              <div className="adm-item" key={it.product_id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {ref.image ? <img src={ref.image} alt="" /> : <div className="adm-item-noimg" />}
                <div className="adm-item-meta">
                  <div>{ref.label}{!ref.known && <span className="adm-muted"> (wycofany)</span>}</div>
                  <div className="id">{ref.id} · {ref.category}</div>
                </div>
                <div className="adm-num">{formatMoney(it.unit_price, order.currency)}</div>
              </div>
            );
          })}
          <div className="adm-item adm-item--strong">
            <div className="adm-item-meta">Razem (z dostawą {formatMoney(order.shipping, order.currency)})</div>
            <div className="adm-num">{formatMoney(order.total, order.currency)}</div>
          </div>
        </div>

        {/* Customer */}
        <div className="adm-panel">
          <h3>Klient</h3>
          <dl className="adm-dl">
            <dt>E-mail</dt><dd>{order.email ?? '—'}</dd>
            <dt>Odbiorca</dt><dd>{[order.receiver_first_name, order.receiver_last_name].filter(Boolean).join(' ') || '—'}</dd>
            <dt>Telefon</dt><dd><PhoneLink phone={order.receiver_phone} /></dd>
            <dt>Język</dt><dd>{order.locale ?? '—'}</dd>
          </dl>
        </div>

        {/* Payment */}
        <div className="adm-panel">
          <h3>Płatność</h3>
          <dl className="adm-dl">
            <dt>Status</dt><dd>{payment ? payment.status : <span className="adm-muted">Stripe niedostępny · DB: {order.status}</span>}</dd>
            <dt>Kwota</dt><dd>{formatMoney(order.total, order.currency)}</dd>
            {payment?.cardLast4 ? <><dt>Karta</dt><dd>{payment.cardBrand} ···· {payment.cardLast4}</dd></> : null}
            {payment && payment.refundedMinor > 0 ? (
              <><dt>Zwrócono</dt><dd>{formatMoney(payment.refundedMinor, order.currency)}{fullyRefunded ? ' (pełny)' : ''}</dd></>
            ) : null}
            <dt>PaymentIntent</dt><dd className="adm-mono">{order.payment_intent_id ?? '—'}</dd>
            <dt>Faktura</dt><dd className="adm-mono">{order.invoice_id ?? '—'}</dd>
            {payment?.receiptUrl ? <><dt>Paragon</dt><dd><a href={payment.receiptUrl} target="_blank" rel="noreferrer">Otwórz ↗</a></dd></> : null}
          </dl>
        </div>

        {/* Delivery */}
        <div className="adm-panel">
          <h3>Dostawa</h3>
          <dl className="adm-dl">
            <dt>Metoda</dt><dd>{deliveryLabel(order.delivery_method)}</dd>
            {order.inpost_target_point ? <><dt>Paczkomat</dt><dd className="adm-mono">{order.inpost_target_point}</dd></> : null}
            {addr ? <><dt>Adres</dt><dd>{[addr.street, addr.building_number].filter(Boolean).join(' ')}, {addr.post_code} {addr.city} {addr.country_code}</dd></> : null}
            <dt>Status InPost</dt><dd>{order.delivery_status ?? '—'}</dd>
            <dt>Nr przesyłki</dt><dd className="adm-mono">{order.inpost_shipment_id ?? '—'}</dd>
            <dt>Tracking</dt><dd className="adm-mono">{order.inpost_tracking_number ?? '—'}</dd>
          </dl>
        </div>

        {/* Packages */}
        <PackingPanel deliveryMethod={order.delivery_method} productIds={order.items.map((it) => it.product_id)} />

        {/* Timeline */}
        <div className="adm-panel">
          <h3>Oś czasu</h3>
          <ul className="adm-timeline">
            {timeline.map((t) => (
              <li key={t.label} className={t.at ? 'done' : 'pending-step'}>
                <span>{t.label}</span>
                <span className="adm-num">{formatDateTime(t.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <OrderActions
        orderId={order.id}
        status={order.status}
        hasEmail={!!order.email}
        hasShipment={!!order.inpost_shipment_id}
        canRefund={order.status === 'paid' && !fullyRefunded}
        amountLabel={formatMoney(order.total, order.currency)}
      />
    </>
  );
}
