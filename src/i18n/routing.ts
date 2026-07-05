import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  // The storefront supports four locales; Polish is the default (no URL prefix).
  // Currency is a separate concern from locale (see src/lib/currency.ts): the
  // former `gb` locale was collapsed into `en`, and GBP is now a cookie-driven
  // display currency rather than its own URL space.
  locales: ['pl', 'en', 'es', 'de'],
  defaultLocale: 'pl',
  // `/` → PL, `/en`, `/es`, `/de`. Only non-default locales get a prefix.
  localePrefix: 'as-needed',
});

export type Locale = (typeof routing.locales)[number];
