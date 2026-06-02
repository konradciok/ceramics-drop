import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/site.css';

import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { AnalyticsEvents } from '@/components/analytics/AnalyticsEvents';
import { GoogleTagManager } from '@/components/analytics/GoogleTagManager';

export const metadata: Metadata = {
  title: 'Anna Ciok Ceramics',
  description: 'Anna Ciok Ceramics — ręcznie malowana ceramika, czerwcowy drop.',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  // Enable static rendering for this locale.
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body>
        <GoogleTagManager containerId={process.env.NEXT_PUBLIC_GTM_ID} />
        <NextIntlClientProvider>
          <AnalyticsEvents />
          <Header />
          {children}
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
