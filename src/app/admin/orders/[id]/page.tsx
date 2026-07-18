import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrder } from '@/lib/admin/data';
import { adminStripe } from '@/lib/admin/clients';
import { productRef } from '@/lib/admin/products';
import { formatMoney } from '@/lib/admin/money';
import { PackingPanel } from '../../packing-ui';
import { formatDateTime, StatusPill, deliveryLabel, shortId, PhoneLink } from '../../ui';
import { OrderActions } from './OrderActions';
import { formatShippingAddress } from '@/lib/shipping-address';

export const dynamic = 'force-dynamic';

type PaymentInfo = {
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl: string | null;
  refundedMinor: number;
};

type PaymentResult =
  | { ok: true; info: PaymentInfo }
  | { ok: false; reason: 'no_pi' | 'stripe_error' };

async function loadPayment(paymentIntentId: string | null): Promise<PaymentResult> {
  if (!paymentIntentId) return { ok: false, reason: 'no_pi' };
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
      ok: true,
      info: {
        status: pi.status,
        cardBrand: card?.brand ?? null,
        cardLast4: card?.last4 ?? null,
        receiptUrl: charge?.receipt_url ?? null,
        refundedMinor: charge?.amount_refunded ?? 0,
      },
    };
  } catch {
    return { ok: false, reason: 'stripe_error' };
  }
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();

  const payment = await loadPayment(order.payment_intent_id);
  const fullyRefunded = payment.ok ? payment.info.refundedMinor >= order.total : order.status === 'refunded';
  const addressLabel = formatShippingAddress(order.shipping_address);

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

      <div className="adm-detail-layout">
        <section className="adm-detail-main">
          {/* Items */}
          <div className="adm-panel">
            <h3>Pozycje</h3>
            {order.items.map((it) => {
              const ref = productRef(it.product_id);
              const variant = it.variant as {
                assetSha256?: string;
                assetId?: string;
              } | null | undefined;
              const assetHint = variant?.assetSha256
                ? ` · asset ${variant.assetSha256.slice(0, 8)}`
                : '';
              return (
                <div className="adm-item" key={it.product_id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {ref.image ? <img src={ref.image} alt="" /> : <div className="adm-item-noimg" />}
                  <div className="adm-item-meta">
                    <div>{ref.label}{!ref.known && <span className="adm-muted"> (wycofany)</span>}</div>
                    <div className="id">{ref.id} · {ref.category}{assetHint}</div>
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
        </section>

        <aside className="adm-detail-side">
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
              <dt>Status</dt>
              <dd>
                {payment.ok ? (
                  payment.info.status
                ) : payment.reason === 'no_pi' ? (
                  <span className="adm-muted">Brak PaymentIntent — zamówienie nieopłacone</span>
                ) : (
                  <span className="adm-muted">Stripe niedostępny · DB: {order.status}</span>
                )}
              </dd>
              <dt>Kwota</dt><dd>{formatMoney(order.total, order.currency)}</dd>
              {payment.ok && payment.info.cardLast4 ? (
                <><dt>Karta</dt><dd>{payment.info.cardBrand} ···· {payment.info.cardLast4}</dd></>
              ) : null}
              {payment.ok && payment.info.refundedMinor > 0 ? (
                <><dt>Zwrócono</dt><dd>{formatMoney(payment.info.refundedMinor, order.currency)}{fullyRefunded ? ' (pełny)' : ''}</dd></>
              ) : null}
              <dt>PaymentIntent</dt><dd className="adm-mono">{order.payment_intent_id ?? '—'}</dd>
              <dt>Faktura</dt><dd className="adm-mono">{order.invoice_id ?? '—'}</dd>
              {payment.ok && payment.info.receiptUrl ? (
                <><dt>Paragon</dt><dd><a href={payment.info.receiptUrl} target="_blank" rel="noreferrer">Otwórz ↗</a></dd></>
              ) : null}
            </dl>
          </div>

          {/* Delivery */}
          <div className="adm-panel">
            <h3>Dostawa</h3>
            <dl className="adm-dl">
              <dt>Metoda</dt><dd>{deliveryLabel(order.delivery_method)}</dd>
              {order.inpost_target_point ? <><dt>Paczkomat</dt><dd className="adm-mono">{order.inpost_target_point}</dd></> : null}
              {addressLabel ? <><dt>Adres</dt><dd>{addressLabel}</dd></> : null}
              <dt>Status InPost</dt><dd>{order.delivery_status ?? '—'}</dd>
              <dt>Nr przesyłki</dt><dd className="adm-mono">{order.inpost_shipment_id ?? '—'}</dd>
              <dt>Tracking</dt><dd className="adm-mono">{order.inpost_tracking_number ?? '—'}</dd>
            </dl>
          </div>

          {/* Actions */}
          <div className="adm-panel">
            <h3>Akcje</h3>
            <OrderActions
              orderId={order.id}
              status={order.status}
              hasEmail={!!order.email}
              hasShipment={!!order.inpost_shipment_id}
              canRefund={order.status === 'paid' && !fullyRefunded}
              amountLabel={formatMoney(order.total, order.currency)}
            />
          </div>
        </aside>
      </div>
    </>
  );
}
