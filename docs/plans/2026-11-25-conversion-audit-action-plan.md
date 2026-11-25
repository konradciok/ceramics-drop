# Conversion audit — action plan (2026-11-25)

**Status:** active · **Owner:** Konrad · **Source:** two storefront audits run on
2026-11-25 (one against a hermetic local build + production DB aggregates, one
against the live site). Findings below were cross-verified; anything not
verified is marked so.

This file is a work queue for coding agents. Sales figures are deliberately
left out (the repo is public) — they live in the private audit report.

## How to use this file

- **One task = one session = one PR.** Start a session with: *"Implement task
  T<n> from `docs/plans/2026-11-25-conversion-audit-action-plan.md`."* Do not
  batch tasks; they touch different surfaces and need separate review.
- Work top to bottom unless told otherwise. T1 and T2 are bugs; the rest are
  improvements.
- Title PRs as `fix:` / `feat:` (they should ship a release — see `AGENTS.md`
  § Versioning). Tick the task's checkbox in this file in the same PR.
- When every task is done or dropped, move this file to `docs/archive/` and
  update `docs/README.md`.

### Rules that apply to every task

- Read `AGENTS.md` first. Non-negotiables: webpack-only build, no
  `unstable_cache` around catalogue reads, catalogue-consuming routes stay
  dynamic, `Link`/`useRouter` from `src/i18n/navigation.ts`.
- **Copy:** every string lives in `messages/{pl,en,es,de}.json` — change all
  four locales. Customer-facing copy is owner-approved
  (`docs/copy-source-of-truth.md`): propose the wording in the PR description
  and mark it as needing approval. **Never invent facts** (care instructions,
  dates, guarantees) — if a task needs a fact that is not in the repo, stop and
  ask.
- **Shipping prices:** read `getShippingRatesForDisplay()` + `deliveryRatesFor()`,
  never the `SHIPPING_*` constants (`display-parity.test.ts` enforces it).
- Before opening the PR: `npm run lint && npm run typecheck && npm run test`,
  plus the `@ci` E2E specs named in the task.

### Looking at the site

Do **not** point a browser at production from a cloud session: Cloudflare
serves US IPs a managed challenge (`docs/cloudflare-deployment.md` § US bot
traffic). Use the hermetic build, the same way `playwright.config.ts` does:

```bash
NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN=e2e-placeholder \
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_e2e_placeholder \
NEXT_PUBLIC_SENDCLOUD_PUBLIC_KEY=e2e-placeholder npm run build
E2E_CERAMIC_SALE_FIXTURE=1 npm run start   # http://localhost:3000
```

Differences from production: every piece renders as available, both drops are
listed, and the hero falls back to committed copy (production reads the CMS).
Check mobile at 390 × 844 and desktop at 1440 × 900.

---

## Bugs

### [x] T1 — Choosing PL does not stick: links fall back to `/en` and EUR

**Severity:** high for affected visitors (anyone whose browser language is not
Polish and who picks PL — e.g. Poles abroad). Reach is unknown; GA4 has a
`language_change` event that can size it.

**Reproduced** on the hermetic build with a browser whose language is `en-US`:

1. Open `/` → redirected to `/en` (expected: locale detection). No
   `NEXT_LOCALE` cookie yet.
2. Click **PL** in the header switcher → URL `/`, `<html lang="pl">`. The
   `NEXT_LOCALE` cookie now exists with value **`en`** (session cookie, path
   `/`, not HttpOnly).
3. Click the hero CTA (`href="/sklep"`) → lands on **`/en/sklep`**, prices in €.
4. Same from `/en/sklep` → PL → category chip `href="/kubki"` → `/en/kubki`.
   A typed `/sklep` also redirects to `/en/sklep`.

Because currency follows locale (`pl → PLN`, others → EUR), the price of the
same piece flips from 95 zł to 25 € mid-session.

**Where:** `src/components/layout/LangSwitch.tsx` (`router.replace(pathname,
{ locale })`), `src/i18n/routing.ts` (defaults: locale detection on, default
locale cookie), `src/middleware.ts` (`handleI18n`), next-intl `^4.13`.

**Root cause (confirmed 2026-11-25, fixed in `src/middleware.ts`):** the
hypothesis held. next-intl's client router writes `NEXT_LOCALE=pl` on the
switch, but the `/en` page keeps issuing `/en/*` router prefetches; they land
afterwards and next-intl's middleware `syncCookie` answers each with
`Set-Cookie: NEXT_LOCALE=en`. Next strips `Next-Router-Prefetch`/`RSC` before
middleware runs, so the fix keys on `Next-Url` (sent only by the client
router) and neutralises the server-side sync for those fetches; document loads
still switch the locale. Guarded by `e2e/locale-switch-sticks.spec.ts`.

**Do:** write the failing test first, then make an explicit language choice
win over `Accept-Language` for the rest of the visit (and ideally across
visits — consider a persistent cookie).

**Acceptance** (new `@ci` Playwright spec, context locale `en-US`):

- After choosing PL: home → hero CTA → `/sklep`, a category, a PDP and
  `/koszyk` all stay unprefixed, `lang="pl"`, prices in zł — also after reload,
  browser back, and a typed unprefixed URL.
- Reverse case still works: a `pl-PL` browser that picks EN stays on `/en/*`.
- First-visit detection is unchanged (an `en-US` browser opening `/` still
  lands on `/en`).
- `e2e/seo-routing.spec.ts` and `e2e/seo-metadata.spec.ts` stay green
  (canonical/hreflang untouched).

### [ ] T2 — `/sklep` lists sold pieces under "Dostępne teraz"

**Evidence:** under the heading `ceramicShop.availableTitle` ("Dostępne teraz")
the gallery renders `pieces`, which is every family's on-sale pieces followed
by that family's **sold** ones. On the live site that meant five buyable mugs,
then thirteen that cannot be bought, before the next family starts. With half a
drop sold, half the list is dead ends.

**Where:** `src/components/shop/CeramicShopScreen.tsx` — `summariseCeramicShop`
(`pieces.push(...purchasableFirst(inFamily))`) and the `<Gallery products={pieces}>`
under the available section. This order is **intentional and tested**
(`CeramicShopScreen.test.ts` "orders the gallery per family…",
`e2e/ceramic-shop.spec.ts`) — change the tests with the behaviour.

**Do:**

- The gallery under "Dostępne teraz" shows only `available`.
- Sold pieces stay reachable but out of the way: a separate, clearly labelled
  section after the family cards, or a link per family to its collection page
  (which already has the All / Available / Sold filter).
- A reserved piece (not purchasable, not sold) must carry a truthful label —
  today it shows an inactive button with no explanation.

**Acceptance:** with a mixed fixture, no sold or reserved tile appears between
the heading and the family cards; the empty state (`availableEmpty`) still
renders when nothing is purchasable; sold pieces remain reachable in one click.

### [x] T3 — PDP "Więcej z kolekcji" recommends sold pieces

**Evidence:** `src/components/shop/ProductPageScreen.tsx` takes the first four
pieces of the category (`.slice(0, 4)`) regardless of sale state. On the live
site three of the four recommendations under an available mug were sold.

**Do:** prefer purchasable siblings (`purchasableFirst` from
`src/lib/status-filter.ts`); fill with sold ones only if fewer than four are
purchasable. On a **sold** PDP, show up to three purchasable pieces above the
fold of that section, and when the category has none, show the newsletter
signup instead (see T9).

**Acceptance:** unit test for the sibling selection; on a sold PDP the first
recommendation is purchasable whenever one exists in the category.

### [ ] T4 — Mobile listing tiles: price wraps, caption overlaps, consent banner hides the hero CTA

Verified at 390 px on the hermetic build.

- **Price wraps** to two lines ("119" / "zł") on tiles with a long name:
  `.tile-meta .pr` in `src/styles/site.css` (~line 610). In the PDP
  "more from" row the name runs into the price ("Kubek Nº 0195 zł"):
  `.tile-static-meta` (~line 1448).
- **Legibility:** name and price are white text over light ceramic photos.
- **Consent banner** (`.consent`, `site.css` ~line 756;
  `src/components/consent/ConsentBanner.tsx`) covers the hero headline and CTA
  on the first mobile screen.

**Do:** keep the price on one line; give name and price a legible treatment
(for example below the image instead of over it); make the consent banner
compact on narrow screens so the hero CTA stays visible. Do not change consent
behaviour (Consent Mode v2 defaults, button semantics).

**Acceptance:** at 390 px no tile price wraps for a three-digit price with the
longest category name; the hero CTA is visible and tappable while the consent
banner is open; `e2e/consent-banner.spec.ts`, `e2e/narrow-layout.spec.ts`,
`e2e/tile-a11y.spec.ts` and `e2e/hero-header.spec.ts` stay green.

**Follow-up in the same PR if the tiles become self-explanatory:** remove the
`collection.hint` instruction box (`.shop-hint`) from `/sklep` and the
collection pages — owner approval needed.

### [ ] T5 — Mobile PDP: "Dodaj do koszyka" is below the fold; cart bar hides count and total

- On a 390 × 844 screen the first PDP view ends at the price; the add-to-cart
  button sits roughly 1 300 px down
  (`src/components/shop/AddToCartButton.tsx`, `ProductPageScreen.tsx`).
- `src/components/shop/SelectionBar.tsx` renders the piece count and total,
  but at 390 px only "Wyczyść" and "Przejdź do kasy" are visible
  (`.selbar-info` is squeezed out, `site.css` ~line 720). "Wyczyść" sits next
  to the primary action with similar weight.

**Do:** add a sticky add-to-cart control on mobile PDPs (price + button) that
yields to the selection bar once the piece is in the cart and does not collide
with the consent banner or the image zoom; on mobile show count and total in
the selection bar and demote "clear".

**Acceptance:** at 390 px a buy control is visible without scrolling on an
available PDP; sold and showroom PDPs show no buy control; the selection bar
shows "n prac · total" at 390 px; `e2e/checkout-button-size.spec.ts` and
`e2e/product-gallery-nav.spec.ts` stay green.

---

## Improvements

### [ ] T6 — PDP and cart: say what delivery costs for *this* visitor, and that it is per order

**Evidence:** for a Polish visitor `src/components/shop/PdpDelivery.tsx` lists
"Paczkomat lub punkt InPost, Hiszpania" first and hides Poland under "pozostałe
kraje"; the "Szacunkowo od" line reads like a second, higher price. Delivery is
a flat fee per order — `shipping.s1P` already says "Koszt nie zależy od liczby
zamówionych prac" — but neither the PDP nor the cart says so. The damage
guarantee (`shipping.s6P`: replacement or full refund including shipping) and
the 14-day return are only on `/dostawa-i-zwroty`.

**Do:**

- When the visitor's destination resolves to one country (the component already
  resolves it from `CF-IPCountry`, then the locale), show one row naming that
  country; keep the zone rows for everyone else.
- Add one line near the price on the PDP and next to the delivery line in the
  cart: flat fee for the whole order, more pieces travel in the same parcel.
- Add a short trust line under the add-to-cart button and above the pay button:
  damage guarantee + 14-day return, linking to the matching sections of
  `/dostawa-i-zwroty`.

**Acceptance:** `display-parity.test.ts` and `e2e/pdp-transparency.spec.ts`
stay green; with `pl` locale and no `CF-IPCountry` the PDP names Poland and its
price; copy present in all four locales.

### [ ] T7 — Navigation and footer: "Ceramika" leads to the archive, gift card sits under "Malarstwo"

**Evidence:** in `src/components/layout/Header.tsx` the item labelled
`nav.showroom` ("Ceramika") links to `/showroom` — the ended drop's archive,
where almost nothing can be bought online — while "Sklep" is the actual shop.
In `src/components/layout/Footer.tsx` the gift-card link is in the `footer.hArt`
("Malarstwo") column although the card only pays for ceramics.

**Do:** rename the menu item so it reads as an archive (all four locales; the
key appears twice in `messages/pl.json`); add a prominent "see what is
available now" link at the top of `/showroom`; move the gift-card link to the
`footer.hShop` column.

**Acceptance:** `e2e/footer.spec.ts` updated and green; no menu item named like
the shop points at the archive.

### [ ] T8 — Announcement bar and home page: promote the live drop, show pieces with prices

**Evidence:** the bar on every page (`<AnnounceBar text={t('announce')}
href={printShopUrl(locale)} />` in `Header.tsx`) advertises the separate print
shop and links out of the store during an active drop. The home page shows no
piece with a price — only the artist section and family cards.

**Do:**

- Point the bar at `/sklep` with drop copy. The print shop keeps its menu and
  footer links.
- On the home page add a row of 6–8 purchasable pieces with prices directly
  under the hero, before the artist section
  (`src/app/[locale]/page.tsx`; reuse the tile components). The route must stay
  dynamic.

**Needs from the owner before merge:** the bar wording and, if it mentions
Christmas, the last order date for delivery before the holidays. Do not
compute or guess that date.

### [ ] T9 — Drop-list signup where demand is lost

**Evidence:** the newsletter form exists only in the footer. A sold PDP ends in
a disabled "Sprzedane" button; the thank-you page (`src/app/[locale]/koszyk/return`)
and the order emails carry no invitation to the next drop.

**Do:** reuse the existing double opt-in flow (`/api/newsletter`, fail-closed
without `NEWSLETTER_CONFIRM_SECRET`) in three places: on sold PDPs ("notify me
about the next drop"), on the thank-you page, and as a secondary action in the
home hero area. Track each placement with the existing
`newsletter_signup_requested` event and its `placement` param (T3 added
`footer` / `sold_pdp`; add new values, not new events — see
`docs/analytics-stack.md`). The sold-PDP placement already exists (T3) when the
family has nothing left to buy; T9 extends it to every sold PDP.

**Acceptance:** each placement submits to the existing endpoint and shows the
existing confirmation state; nothing is subscribed without the confirm link.

### [ ] T10 — Content fixes that contradict the storefront

- **Terms §3 currency:** `terms.s3P` in `messages/en.json` and
  `messages/es.json` says all prices are in PLN, while those locales display
  EUR (GBP switchable); `de` already says EUR. Legal copy — propose wording,
  owner approves.
- **Canary Islands:** `shipping.s1Li3` says the Canaries are quoted
  individually, while the cart's "Hiszpania" option carries no caveat. Add a
  short note to the Spain option (mainland and Balearics).
- **Gift-card page bio:** the artist bio on `/karta-podarunkowa` comes from the
  CMS document `page:print-pdp` and talks about prints, which the card does not
  cover. This is a **CMS edit, not a code change** — list it in the PR
  description for the operator; fix the committed fallback (`printPdp.artistBio`)
  so it matches.

### [ ] T11 — Remove the El Médano market page

The event was on 2026-10-24 and `docs/STATUS.md` says to remove the page
afterwards; the copy still says "this Saturday". Remove
`src/app/[locale]/el-medano/`, `src/components/market/`, `messages/market/`,
the `market` namespace in `messages/*.json` and `src/lib/market-metadata.ts`;
redirect `/el-medano*` to the home page; update `docs/STATUS.md`. Keep
`placement` in `GA4_EVENT_PARAMS` (`scripts/gtm-api.mjs`) and
`GA4_EVENT_SCOPED_PARAMS` (`src/lib/analytics.ts`) — the newsletter event uses
it too. Title the PR `chore:`.

---

## Blocked on owner input (do not start without it)

| Item | What is missing |
|---|---|
| "Use and care" block on PDPs (dishwasher, microwave, food contact, mug capacity) | The facts. Nothing in the repo states them; mug capacity (300 ml) appears only in a meta description. |
| Christmas order deadline in bar / hero / cart | The date, confirmed by the studio. |
| Motif-based product names and SEO titles ("Kubek z czarną gałązką · Nº 03") | Names for each piece in four locales. `Product.title` already overrides the generated name. Two different pieces are both called "Kubek Nº 03" today (drop 1 and drop 2). |
| Free-shipping threshold | A business decision on margin. |
| Welcome promo code for new subscribers | Operator confirmation — see the open item in `docs/promo-codes.md`. |
| More photos per piece (only three pieces have a second photo) | Photo session; then `optimize-images` + gallery data. |
| Customer reviews section | Collected reviews and consent to publish. |

## Operator checks (no code)

- [ ] **Spanish pickup-point picker.** One audit saw the Sendcloud overlay open
  with filters but no search field or list (desktop Chrome). Not reproduced;
  it cannot run on the hermetic build. Test on a real phone: Spain from the
  start, and Poland → Spain, postcodes 28001 and 46001. If it fails, open a
  bug with the device and steps.
- [ ] **Home hero** is CMS content (`page:home`) and has not changed since
  before the current drop — update it in the CMS.
- [ ] **GA4:** size T1 with `language_change` (from → to), and review the drop
  funnel (item views → add to cart → begin checkout → purchase).
- [ ] **Abandoned-checkout email:** the template exists in
  `src/lib/resend-events.ts`; confirm the Resend automation is switched on.

## Later (after the tasks above)

- Sort by price and filter by motif on `/sklep`.
- "Goes with" recommendations across forms (same motif on a mug and a plate).
- A pre-drop landing page with the start date and the signup form.

## Leave alone

Checkout and payment, the one-page cart, add-to-cart on tiles, and the
"one of a kind" messaging tested well in both audits. Do not redesign them as
part of these tasks.
