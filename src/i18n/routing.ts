import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  // The storefront is trilingual; Polish is the default (no URL prefix).
  locales: ['pl', 'en', 'es'],
  defaultLocale: 'pl',
  // `/` → PL, `/en`, `/es`. Only non-default locales get a prefix.
  localePrefix: 'as-needed',
});

export type Locale = (typeof routing.locales)[number];
