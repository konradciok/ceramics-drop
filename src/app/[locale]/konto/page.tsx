import '@/styles/account.css';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { listAccountOrders } from '@/lib/account/orders';
import { customerOrderStatus } from '@/lib/account/status';
import { accountItemLabel, formatOrderAmount, formatOrderDate } from '@/lib/account/items';
import { SignInPanel } from '@/components/account/SignInPanel';
import { SignOutButton } from '@/components/account/SignOutButton';

// Session-specific surface: always dynamic (the middleware refreshes the
// session cookie on this path), never indexed, never sitemapped.
export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ auth_error?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('title.konto'), robots: { index: false } };
}

export default async function KontoPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });

  // Fail-closed feature gate: without SUPABASE_PUBLISHABLE_KEY the page renders
  // a calm, deterministic "unavailable" notice (hermetic E2E relies on this).
  if (!authEnabled()) {
    return (
      <main>
        <section className="page-head">
          <div className="page-head-inner">
            <div>
              <div className="eyebrow">{t('account.eyebrow')}</div>
              <h1>{t('account.heading')}</h1>
            </div>
          </div>
        </section>
        <div className="account-wrap">
          <div className="account-panel" data-testid="konto-unavailable">
            <h2>{t('account.unavailableH')}</h2>
            <p className="account-note">{t('account.unavailableP')}</p>
          </div>
        </div>
      </main>
    );
  }

  const user = await getSessionUser();

  if (!user) {
    const { auth_error } = await searchParams;
    const nextPath = locale === 'pl' ? '/konto' : `/${locale}/konto`;
    return (
      <main>
        <section className="page-head">
          <div className="page-head-inner">
            <div>
              <div className="eyebrow">{t('account.eyebrow')}</div>
              <h1>{t('account.heading')}</h1>
            </div>
          </div>
        </section>
        <div className="account-wrap">
          <SignInPanel next={nextPath} showError={Boolean(auth_error)} />
        </div>
      </main>
    );
  }

  const { orders, jobStatusByOrder } = await listAccountOrders(user.id);

  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div>
            <div className="eyebrow">{t('account.eyebrow')}</div>
            <h1>{t('account.heading')}</h1>
          </div>
        </div>
      </section>
      <div className="account-wrap" data-testid="konto-signed-in">
        <div className="account-panel account-header">
          <div className="who">
            <strong>{user.name ?? user.email ?? t('account.heading')}</strong>
            {user.email && <span>{user.email}</span>}
          </div>
          <SignOutButton />
        </div>

        <div className="account-panel">
          <h2>{t('account.ordersH')}</h2>
          {orders.length === 0 ? (
            <>
              <p className="account-note">{t('account.empty')}</p>
              <Link href="/sklep" className="btn btn-primary">{t('account.emptyCta')}</Link>
            </>
          ) : (
            <ul className="account-orders">
              {orders.map((order) => {
                const { status } = customerOrderStatus({
                  status: order.status,
                  fulfilmentType: order.fulfilment_type,
                  deliveryMethod: order.delivery_method,
                  deliveryStatus: order.delivery_status,
                  inpostTrackingNumber: order.inpost_tracking_number,
                  latestJobStatus: jobStatusByOrder.get(order.id) ?? null,
                  prodigiTracking: null,
                });
                const names = order.items
                  .map((item) => accountItemLabel(item, t, locale).name)
                  .join(', ');
                return (
                  <li key={order.id} className="account-order-row" data-testid="konto-order-row">
                    <div className="row-top">
                      <time dateTime={order.created_at}>
                        {formatOrderDate(order.paid_at ?? order.created_at, locale)}
                      </time>
                      <span className={`status-chip status-${status}`}>
                        {t(`account.status.${status}`)}
                      </span>
                    </div>
                    <div className="row-items">{names}</div>
                    <div className="row-bottom">
                      <span className="row-total">
                        {formatOrderAmount(order.total, order.currency, locale)}
                      </span>
                      <Link href={`/konto/zamowienia/${order.id}`} className="btn btn-ghost">
                        {t('account.viewOrder')}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
