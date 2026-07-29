import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const GENERATED_AND_EXTERNAL_PATHS = [
  'design/**',
  '.next/**',
  '**/.next/**',
  '.open-next/**',
  '**/.open-next/**',
  '.wrangler/**',
  '**/.wrangler/**',
  'node_modules/**',
  '**/node_modules/**',
  '.claude/**',
  '.worktrees/**',
  'pr-review/**',
];

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: GENERATED_AND_EXTERNAL_PATHS,
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'gtag', message: 'Use pushDataLayer() from src/lib/analytics.ts — never call gtag() directly.' },
        { name: 'fbq', message: 'Use pushDataLayer() from src/lib/analytics.ts — never call fbq() directly.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'gtag', message: 'Use pushDataLayer() — never call window.gtag() directly.' },
        { object: 'window', property: 'fbq', message: 'Use pushDataLayer() — never call window.fbq() directly.' },
        { object: 'globalThis', property: 'gtag', message: 'Use pushDataLayer() — never call globalThis.gtag() directly.' },
        { object: 'globalThis', property: 'fbq', message: 'Use pushDataLayer() — never call globalThis.fbq() directly.' },
      ],
      // no-restricted-globals/-properties above miss a call like `globalThis.gtag(...)`
      // or `window.fbq?.(...)`; this catches every member call of gtag/fbq on
      // window/globalThis (incl. optional-call `?.()`). NOTE: a fully aliased
      // reference (`const g = window.gtag; g();`) is inherently beyond static
      // lint — that gap is covered by code review, not this rule.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name=/^(gtag|fbq)$/]",
          message: 'Use pushDataLayer() from src/lib/analytics.ts — never call gtag()/fbq() via window/globalThis.',
        },
      ],
    },
  },
  {
    // The Consent Mode CMP is the one sanctioned direct-gtag caller (consent
    // signals are GTM-internal and never reach GA4/Meta as events). Its
    // `window.gtag?.(...)` is both a restricted property AND a restricted member
    // call, so both rules are disabled for this one file.
    files: ['src/components/consent/consent-mode.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
];

export default eslintConfig;
