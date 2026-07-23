import '@/styles/account.css';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { getAccountOrder } from '@/lib/account/orders';
import { customerOrderStatus } from '@/lib/account/status';
import { accountItemLabel, formatOrderAmount, formatOrderDate } from '@/lib/account/items';
import { formatShippingAddress } from '@/lib/shipping-address';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string; id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('title.konto'), robots: { index: false } };
}

const METHOD_KEY: Record<string, string> = {
  paczkomat: 'account.methodPaczkomat',
  kurier: 'account.methodKurier',
  odbior: 'account.methodOdbior',
};

export default async function KontoOrderPage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // Signed-out (or accounts disabled) → the account landing handles both
  // states; the order id reveals nothing about whether such an order exists.
  if (!authEnabled()) redirect({ href: '/konto', locale });
  const user = await getSessionUser();
  if (!user) {
    redirect({ href: '/konto', locale });
    return null; // unreachable — redirect throws (satisfies narrowing)
  }

  // Ownership-filtered lookup — unknown id, foreign order, unsettled status
  // all 404 identically (anti-enumeration, same posture as /api/returns).
  const result = await getAccountOrder(id, user.id);
  if (!result) notFound();
  const { order, fulfilment } = result;

  const t = await getTranslations({ locale });
  const { status, tracking } = customerOrderStatus({
    status: order.status,
    fulfilmentType: order.fulfilment_type,
    deliveryMethod: order.delivery_method,
    deliveryStatus: order.delivery_status,
    inpostTrackingNumber: order.inpost_tracking_number,
    latestJobStatus: fulfilment.latestJobStatus,
    prodigiTracking: fulfilment.prodigiTracking,
  });

  const address = formatShippingAddress(order.shipping_address);
  const methodKey = METHOD_KEY[order.delivery_method ?? ''];
  const isCeramicOrder = order.items.some((item) => item.variant == null);
  const shippedAt = fulfilment.prodigiTracking?.shippedAt ?? null;

  return (
    <main>
      <div className="account-wrap" data-testid="konto-order-detail">
        <div>
          <Link href="/konto" className="account-back">← {t('account.backToAccount')}</Link>
          <div className="account-header" style={{ marginTop: 8 }}>
            <h1 style={{ margin: 0, fontSize: 'clamp(26px, 4vw, 40px)' }}>
              {t('account.orderLabel')}{' '}
              <span style={{ opacity: 0.55, fontSize: '.6em' }}>{order.id.slice(0, 8)}</span>
            </h1>
            <span className={`status-chip status-${status}`}>{t(`account.status.${status}`)}</span>
          </div>
          <p className="account-note" style={{ marginTop: 6 }}>
            {formatOrderDate(order.paid_at ?? order.created_at, locale)}
          </p>
        </div>

        <div className="account-panel">
          <h2>{t('account.itemsH')}</h2>
          <ul className="account-items">
            {order.items.map((item) => {
              const label = accountItemLabel(item, t, locale);
              return (
                <li key={label.key}>
                  <span className="item-name">
                    {label.name}
                    {label.detail && <span className="item-detail">{label.detail}</span>}
                  </span>
                  <span className="item-price">
                    {formatOrderAmount(item.unit_price, order.currency, locale)}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="account-totals">
            <div className="line">
              <span>{t('account.subtotal')}</span>
              <span>{formatOrderAmount(order.subtotal, order.currency, locale)}</span>
            </div>
            <div className="line">
              <span>{t('account.shippingLabel')}</span>
              <span>{formatOrderAmount(order.shipping, order.currency, locale)}</span>
            </div>
            <div className="line total">
              <span>{t('account.total')}</span>
              <span>{formatOrderAmount(order.total, order.currency, locale)}</span>
            </div>
          </div>
        </div>

        <div className="account-panel">
          <h2>{t('account.deliveryH')}</h2>
          <dl className="account-dl">
            {methodKey && (
              <>
                <dt>{t('account.methodLabel')}</dt>
                <dd>{t(methodKey)}</dd>
              </>
            )}
            {order.delivery_method === 'paczkomat' && order.inpost_target_point && (
              <>
                <dt>{t('account.paczkomatLabel')}</dt>
                <dd className="mono">{order.inpost_target_point}</dd>
              </>
            )}
            {address && order.delivery_method !== 'paczkomat' && order.delivery_method !== 'odbior' && (
              <>
                <dt>{t('account.addressLabel')}</dt>
                <dd>{address}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="account-panel" data-testid="konto-tracking">
          <h2>{t('account.trackingH')}</h2>
          {tracking ? (
            <>
              <dl className="account-dl">
                {tracking.carrier && (
                  <>
                    <dt>{t('account.carrier')}</dt>
                    <dd>{tracking.carrier}</dd>
                  </>
                )}
                <dt>{t('account.trackingNumber')}</dt>
                <dd className="mono">{tracking.number}</dd>
                {shippedAt && (
                  <>
                    <dt>{t('account.shippedAt')}</dt>
                    <dd>{formatOrderDate(shippedAt, locale)}</dd>
                  </>
                )}
              </dl>
              {/* Render-side https gate lives in the status mapper: url is null
                  unless it validated, so the bare number above is the fallback. */}
              {tracking.url && (
                <div className="account-actions">
                  <a href={tracking.url} className="btn btn-primary" target="_blank" rel="noreferrer">
                    {t('account.track')}
                  </a>
                </div>
              )}
            </>
          ) : (
            <p className="account-note" style={{ margin: 0 }}>{t('account.noTracking')}</p>
          )}
        </div>

        {isCeramicOrder && order.status === 'paid' && (
          <div className="account-actions">
            {/* Reuse the existing returns flow rather than rebuilding it here. */}
            <Link
              href={{ pathname: '/zwrot', query: { order: order.id } }}
              className="btn btn-ghost"
            >
              {t('account.requestReturn')}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
