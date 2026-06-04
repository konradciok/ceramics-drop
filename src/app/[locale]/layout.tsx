import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/site.css';

import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { AnalyticsEvents } from '@/components/analytics/AnalyticsEvents';
import { GoogleTagManager } from '@/components/analytics/GoogleTagManager';
import { JsonLd } from '@/components/seo/JsonLd';
import { organizationSchema } from '@/lib/seo/structured-data';
import { SITE_URL } from '@/lib/site';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#3A2818',
};

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: 'Anna Ciok Ceramics', template: '%s — Anna Ciok Ceramics' },
    description: t('meta.description'),
    openGraph: {
      type: 'website',
      siteName: 'Anna Ciok Ceramics',
      images: [{ url: '/uploads/kubek-01.webp', width: 1200, height: 800, alt: t('meta.ogImageAlt') }],
    },
    twitter: { card: 'summary_large_image' },
    icons: { apple: '/logotype.png' },
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations();

  return (
    <html lang={locale}>
      <head>
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Variable-latin.woff2" />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Variable-latinExt.woff2" />
        {/* Hero <h1> uses an italic <em> ("malowana ręką.") above the fold — preload italic to avoid LCP swap */}
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Italic-Variable-latin.woff2" />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Italic-Variable-latinExt.woff2" />
      </head>
      <body>
        <JsonLd data={organizationSchema()} />
        <a href="#main-content" className="skip-link">{t('aria.skipToContent')}</a>
        <GoogleTagManager containerId={process.env.NEXT_PUBLIC_GTM_ID} />
        <NextIntlClientProvider>
          <AnalyticsEvents />
          <Header />
          <div id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
            {children}
          </div>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
