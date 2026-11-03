import { notFound } from 'next/navigation';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyGiftCardReceipt } from '@/lib/gift-card-receipt';
import { paymentBreakdownRows } from '@/lib/payment-breakdown';
import { isUuid } from '@/lib/uuid';
import { Link } from '@/i18n/navigation';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

export default async function BalanceOrderConfirmation({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ order?: string; receipt?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  if (!isUuid(query.order) || typeof query.receipt !== 'string') notFound();
  if (!await verifyGiftCardReceipt(query.order, query.receipt, getCloudflareContext().env.SUPABASE_SERVICE_ROLE_KEY)) notFound();
  const { data: order, error } = await getSupabaseAdmin().from('orders')
    .select('id,status,total,currency,gift_card_amount,gift_card_balance_after').eq('id',query.order).maybeSingle();
  if (error) throw new Error('Order confirmation temporarily unavailable');
  if (!order || order.status !== 'paid' || order.gift_card_amount <= 0) notFound();
  const t = await getTranslations({ locale });
  return <main className="section"><div className="section-inner">
    <h1>{t('balanceConfirmation.title')}</h1>
    <p>{t('balanceConfirmation.body')}</p>
    <p>{t('balanceConfirmation.order')}: {order.id}</p>
    <dl>{paymentBreakdownRows(order,locale).map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    <Link className="btn btn-primary" href="/sklep">{t('nav.sklep')}</Link>
  </div></main>;
}
