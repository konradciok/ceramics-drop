import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/site.css';
import '@/styles/motion.css';

import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { Header } from '@/components/layout/Header';
import { HeaderHeightProbe } from '@/components/layout/HeaderHeightProbe';
import { Footer } from '@/components/layout/Footer';
import { AnalyticsEvents } from '@/components/analytics/AnalyticsEvents';
import { AuthAnalytics } from '@/components/analytics/AuthAnalytics';
import { GoogleTagManager } from '@/components/analytics/GoogleTagManager';
import { defaultConsentSnippet } from '@/components/consent/consent-mode';
import { ConsentBanner } from '@/components/consent/ConsentBanner';
import { JsonLd } from '@/components/seo/JsonLd';
import { organizationSchema } from '@/lib/seo/structured-data';
import { CurrencyProvider } from '@/components/currency/CurrencyProvider';
import { getCurrency } from '@/lib/currency.server';
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
    // This template owns the brand suffix, so per-page `title.*` translations
    // must be page-only (e.g. "Mugs", not "Mugs — Anna Ciok Ceramics") or the
    // brand renders twice. `title.home` is the exception — it opts out via
    // `title: { absolute }` in page.tsx. Guarded by title-branding.test.ts.
    title: { default: 'Anna Ciok Ceramics', template: '%s — Anna Ciok Ceramics' },
    description: t('meta.description'),
    openGraph: {
      type: 'website',
      siteName: 'Anna Ciok Ceramics',
      images: [{ url: '/uploads/kubek-1.webp', width: 1200, height: 800, alt: t('meta.ogImageAlt') }],
    },
    twitter: { card: 'summary_large_image' },
    icons: { icon: '/favicon.ico', apple: '/logotype.png' },
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
  // Display currency comes from the `currency_pref` cookie (pl → PLN always);
  // seed the client provider so tiles/cart/PDP render the right currency and the
  // header switcher can change it. `Vary: Cookie` (middleware) keeps caches split.
  const currency = await getCurrency(locale);

  return (
    <html lang={locale}>
      <head>
        <meta name="google-site-verification" content="ODPOvFg6a6l64-89h-HcUeWIlCYAIMWrG7EnGzgJ2V4" />
        <meta name="p:domain_verify" content="862d54c53b404182e314389f2433a3dc" />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Variable-latin.woff2" />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Variable-latinExt.woff2" />
        {/* Hero <h1> uses an italic <em> ("malowana ręką.") above the fold — preload italic to avoid LCP swap */}
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Italic-Variable-latin.woff2" />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href="/fonts/Jost-Italic-Variable-latinExt.woff2" />
      </head>
      <body>
        <JsonLd data={organizationSchema()} />
        <a href="#main-content" className="skip-link">{t('aria.skipToContent')}</a>
        <Script id="consent-default" strategy="beforeInteractive">{defaultConsentSnippet()}</Script>
        <GoogleTagManager containerId={process.env.NEXT_PUBLIC_GTM_ID} />
        <NextIntlClientProvider>
          <CurrencyProvider initial={currency}>
            <AnalyticsEvents />
            <AuthAnalytics />
            <HeaderHeightProbe />
            <Header />
            <div id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
              {children}
            </div>
            <Footer />
            <ConsentBanner />
          </CurrencyProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
