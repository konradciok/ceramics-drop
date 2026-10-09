import '@/styles/market.css';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { requireLocale } from '@/i18n/locale-guard';
import { MarketPage } from '@/components/market/MarketPage';
import { marketMetadata } from '@/lib/market-metadata';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = requireLocale((await params).locale);
  return marketMetadata(locale);
}

/**
 * Campaign landing page for the El Médano handicraft market (Sat 10 Oct 2026)
 * in the four site locales. Six more page-only languages live at
 * `/en/el-medano/<lang>` (see `./[lang]/page.tsx`).
 */
export default async function ElMedanoPage({ params }: Props) {
  const locale = requireLocale((await params).locale);
  setRequestLocale(locale);
  return <MarketPage lang={locale} />;
}
