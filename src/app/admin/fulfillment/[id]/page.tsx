import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  fulfillmentQueueIndex,
  getFulfillmentOrder,
  listFulfillmentQueue,
  type FulfillmentOrder,
  type FulfillmentStage,
} from '@/lib/admin/fulfillment';
import { formatDateTime, PhoneLink, shortId, deliveryLabel } from '../../ui';
import { FulfillmentActions } from '../FulfillmentActions';
import { FulfillmentNavKeys } from './FulfillmentNavKeys';
import { PackingPanel } from '../../packing-ui';

export const dynamic = 'force-dynamic';

const STAGE_LABEL: Record<FulfillmentStage, string> = {
  blocked: 'Zablokowane',
  ready: 'Do zapakowania',
  in_transit: 'W drodze',
  pickup: 'Odbiór osobisty',
};

const PIPELINE: Array<{ stage: FulfillmentStage; label: string }> = [
  { stage: 'blocked', label: 'Przesyłka' },
  { stage: 'ready', label: 'Pakowanie' },
  { stage: 'in_transit', label: 'W drodze' },
];

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

function stageState(orderStage: FulfillmentStage, step: FulfillmentStage): 'done' | 'current' | 'pending-step' {
  const order = ['blocked', 'ready', 'in_transit'];
  const current = order.indexOf(orderStage);
  const target = order.indexOf(step);
  if (orderStage === 'pickup') return 'pending-step';
  if (target < current) return 'done';
  if (target === current) return 'current';
  return 'pending-step';
}

export default async function FulfillmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [order, queue] = await Promise.all([getFulfillmentOrder(id), listFulfillmentQueue()]);
  if (!order) notFound();

  const position = fulfillmentQueueIndex(queue, order.id);
  const prevHref = position.prevId ? `/admin/fulfillment/${position.prevId}` : null;
  const nextHref = position.nextId ? `/admin/fulfillment/${position.nextId}` : null;

  return (
    <>
      <FulfillmentNavKeys prevHref={prevHref} nextHref={nextHref} />
      <Link className="adm-back" href="/admin/fulfillment">← Wysyłka</Link>
      <div className="adm-fulfillment-head">
        <div>
          <h1 className="adm-h1">
            Pakowanie <span className="adm-mono">{shortId(order.id)}</span>
          </h1>
          <p className="adm-sub">
            {position.index >= 0 ? `${position.index + 1} z ${position.total}` : 'Poza kolejką'} · {formatDateTime(order.paid_at ?? order.created_at)} ·{' '}
            {order.items.length} {order.items.length === 1 ? 'praca' : 'prac'}
          </p>
        </div>
        <span className={`adm-pill ${order.stage}`}>{STAGE_LABEL[order.stage]}</span>
      </div>

      <div className="adm-fulfillment-layout">
        <section className="adm-fulfillment-pack">
          {order.itemsEnriched.map((item) => (
            <article className="adm-pack-item" key={item.product_id}>
              {item.ref.image
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={item.ref.image} alt="" />
                : <div className="adm-pack-noimg" />}
              <div>
                <h2>{item.ref.label}{!item.ref.known && <span className="adm-muted"> (wycofany)</span>}</h2>
                <p className="adm-mono">{item.ref.id} · {item.ref.category}</p>
              </div>
            </article>
          ))}
        </section>

        <aside className="adm-fulfillment-side">
          <div className="adm-panel">
            <h3>Dostawa</h3>
            <dl className="adm-dl">
              <dt>Metoda</dt><dd>{deliveryLabel(order.delivery_method)}</dd>
              <dt>Adres / punkt</dt><dd>{deliveryLine(order)}</dd>
              <dt>Status InPost</dt><dd>{order.delivery_status ?? '—'}</dd>
              <dt>Przesyłka</dt><dd className="adm-mono">{order.inpost_shipment_id ?? '—'}</dd>
              <dt>Tracking</dt><dd className="adm-mono">{order.inpost_tracking_number ?? '—'}</dd>
            </dl>
          </div>

          <PackingPanel deliveryMethod={order.delivery_method} productIds={order.items.map((it) => it.product_id)} />

          <div className="adm-panel">
            <h3>Klient</h3>
            <dl className="adm-dl">
              <dt>Odbiorca</dt><dd>{customerName(order)}</dd>
              <dt>Telefon</dt><dd><PhoneLink phone={order.receiver_phone} /></dd>
              <dt>E-mail</dt><dd>{order.email ?? '—'}</dd>
            </dl>
          </div>

          <div className="adm-panel">
            <h3>Etapy</h3>
            {order.stage === 'pickup' ? (
              <ul className="adm-timeline">
                <li className="current"><span>Odbiór osobisty</span><span className="adm-num">{formatDateTime(order.paid_at)}</span></li>
              </ul>
            ) : (
              <ul className="adm-timeline">
                {PIPELINE.map((step) => (
                  <li key={step.stage} className={stageState(order.stage, step.stage)}>
                    <span>{step.label}</span>
                    <span className="adm-num">{step.stage === order.stage ? STAGE_LABEL[order.stage] : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <section className="adm-panel">
            <h3>Akcje</h3>
            <FulfillmentActions orderId={order.id} stage={order.stage} />
          </section>

          <nav className="adm-fulfillment-nav">
            {prevHref ? <Link className="adm-btn" href={prevHref}>← Poprzednie</Link> : <span className="adm-btn disabled">← Poprzednie</span>}
            {nextHref ? <Link className="adm-btn" href={nextHref}>Następne →</Link> : <span className="adm-btn disabled">Następne →</span>}
          </nav>
        </aside>
      </div>
    </>
  );
}
