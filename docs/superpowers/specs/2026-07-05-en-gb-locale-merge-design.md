# EN/GB Locale Merge — Design & Implementation Plan

**Date:** 2026-07-05  
**Status:** Approved direction — Option B (server-side cookie)

## Context

The storefront currently has two English-language locales: `/en/` (EUR, EU market) and `/gb/` (GBP, UK market). The language switcher shows `PL · EN · ES · DE · GB`, where `EN` reads as "English language" but actually means "EU with EUR pricing". This is confusing — a UK visitor may pick `EN` and get EUR prices; an EU visitor who speaks English may not understand what `GB` means.

**Goal:** Collapse `/en/` and `/gb/` into a single `/en/` route. Currency becomes a separate concern: auto-detected from the visitor's Cloudflare `CF-IPCountry` header, stored in a `currency_pref` cookie, and overridable via a header switcher. EUR is the default; GBP is active now; USD and CAD are architected but not exposed in UI.

## Architecture: Option B — Server-side cookie + Vary: Cookie

```
CF-IPCountry header (GB→GBP, all others→EUR)
    ↓ middleware.ts (sets currency_pref cookie if absent)
    ↓ server components read cookie → render correct prices
    ↓ currency switcher updates cookie + triggers reload
```

`/gb/*` URLs → 301 permanent redirect to `/en/*`.

## Files to Change

### 1. `src/i18n/routing.ts`
Remove `gb` from the `locales` array. New list: `['pl', 'en', 'es', 'de']`.

### 2. `src/middleware.ts`
- On first `/en/` request with no `currency_pref` cookie: read `CF-IPCountry`, map `GB → gbp`, default everything else to `eur`. Set `currency_pref` cookie (max-age: 1 year, SameSite=Lax).
- Add 301 redirect rule: any path starting with `/gb` → same path with `/gb` replaced by `/en` (preserve query params and hash).
- Country→currency map: `{ GB: 'gbp' }` (extend later with `US: 'usd', CA: 'cad'`).

### 3. `src/lib/pricing.ts`
- Add `PRICE_USD` and `PRICE_CAD` per-category tables (can be `null` / placeholder for now — will throw if accessed).
- Change `priceOf(product, locale)` signature to also accept currency directly, or add a parallel `priceOfCurrency(product, currency)` function.
- Add `toUSDCents(n)` and `toCADCents(n)` minor-unit converters (same as `toEuroCents` — both are ×100).

### 4. `src/lib/currency.ts` (new, small)
```ts
// Server-side helper — reads currency_pref cookie from Next.js cookies()
export type Currency = 'pln' | 'eur' | 'gbp' | 'usd' | 'cad'
export function getCurrency(locale: string): Currency {
  if (locale === 'pl') return 'pln'
  const cookie = cookies().get('currency_pref')?.value
  return (cookie as Currency) ?? 'eur'
}
```
Reuse `cookies()` from `next/headers` — already available in server components. `pl` locale always forces PLN; other locales use the cookie.

### 5. `src/app/api/checkout/route.ts`
- Replace `locale → currency` derivation with `getCurrency(locale)`.
- Add `case 'usd': toUSDCents(n)` and `case 'cad': toCADCents(n)` branches.

### 6. Database
- Add `usd` and `cad` as valid values to `orders.currency` column. New migration: `ALTER TYPE currency_enum ADD VALUE 'usd'; ADD VALUE 'cad';` (if it's a Postgres enum) or update a check constraint.

### 7. `src/components/layout/CurrencySwitcher.tsx` (new)
- Client component, reads `currency_pref` cookie via `document.cookie` or a `useEffect`.
- Renders pill buttons: `EUR · GBP` (USD/CAD hidden behind a flag or omitted until launched).
- On click: `document.cookie = 'currency_pref=gbp; max-age=...; path=/; SameSite=Lax'` then `router.refresh()`.
- Place in the header next to or replacing the current `LangSwitch` layout (or directly below it).

### 8. `src/components/layout/LangSwitch.tsx`
- Remove the `GB` button (locale no longer exists).
- Now shows: `PL · EN · ES · DE`.

### 9. `messages/en.json` + delete `messages/gb.json`
- Merge any GB-specific strings (currency symbol position for GBP, "UK and EU" shipping copy) into `en.json`.
- Conditionally render currency-specific strings in components using the cookie value, not a separate locale file.
- Delete `messages/gb.json`.

### 10. `src/lib/feed.ts`
- Remove `gb` from `FEED_LOCALES`.
- Consider adding a currency axis for `/en/` feed: generate one EUR feed and one GBP feed, or accept EUR-only for now.

### 11. Product pages / hreflang (`src/app/[locale]/[category]/[id]/page.tsx`)
- Remove `gb` from hreflang alternate link generation.
- Now 4 locales in hreflang: `pl`, `en`, `es`, `de`.

### 12. Any remaining `gb` references
- Grep for `'gb'` across the codebase, clean up: Stripe PMC locale hints, analytics locale tracking, `SHIPPING_COUNTRY` map, etc.

## USD/CAD Future-Proofing

- Define `PRICE_USD` and `PRICE_CAD` tables in `pricing.ts` now (even as `null` per category), so the type is correct.
- `getCurrency()` already returns `'usd' | 'cad'` as valid values — the only remaining work to launch a new market is: fill in price tables, add country→currency mapping in middleware, and unhide USD/CAD buttons in `CurrencySwitcher`.

## Verification

```bash
npm run lint          # No gb references remain
npm run build         # Build passes
npm run test          # Unit tests pass
```

Manual checks:
1. `GET /gb/kubki` → 301 → `/en/kubki`
2. Request to `/en/` with `CF-IPCountry: GB` and no cookie → response sets `currency_pref=gbp`
3. EUR visitor sees `25 €` prices; GBP visitor sees `£22` prices
4. Clicking GBP pill in header → prices update to GBP, cookie persists across navigation
5. Checkout with GBP cookie → Stripe PI charged in GBP pence
6. Feed endpoint `/api/feed/google?locale=gb` → 404 or removed; `/api/feed/google?locale=en` → EUR feed
7. Product page hreflang has 4 locales (no `gb`)
