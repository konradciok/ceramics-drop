# Plan implementacji — Kategoria „Printy fine art" (warianty: rozmiar × papier × rama)

> **Dla wykonawcy (agent/dev):** WYMAGANA PODSKILL: użyj `superpowers:subagent-driven-development` (zalecane) lub `superpowers:executing-plans`, aby wdrażać ten plan zadanie po zadaniu. Kroki używają składni checkbox (`- [ ]`).

**Cel:** Dodać do istniejącego sklepu (Next.js 16 / Supabase / Stripe / Cloudflare Workers) nową kategorię „printy fine art", w której produkt nie jest egzemplarzem 1/1, lecz **projektem konfigurowalnym** — klient wybiera rozmiar × rodzaj papieru × ramę/bez ramy, a cena i SKU zależą od kombinacji.

**Architektura (skrót):** Nie budujemy równoległego systemu handlowego. **Kręgosłup commerce (koszyk → `/api/checkout` → Stripe PaymentIntent → `orders`/`order_items` → webhook → fulfillment) zostaje wspólny.** Różni się tylko: (1) reprezentacja katalogu (osobny typ `PrintDesign` + rejestr `src/lib/prints.ts`, zamiast destabilizować dyskryminowaną unią cały kod ceramiki), (2) PDP z konfiguratorem wariantu, (3) sposób wyceny (per-wariant, liczona serwerowo). Koszyk pozostaje `ids: string[]` — printy kodujemy jako **tokeny złożone** `print:<id>:<size>:<paper>:<frame>`, więc store i większość konsumentów nie zmieniają kształtu.

**Tech stack:** Next.js 16 App Router (RSC + wyspy `'use client'`), next-intl (pl/en/es), Zustand + localStorage, Supabase (Postgres, service-role), Stripe (dynamiczne PaymentIntent, **bez** Stripe Products/Prices), OpenNext na Cloudflare Workers, Vitest, Playwright.

---

## Założenia

1. **Model edycji — MVP = edycja otwarta (open edition / print-on-demand).** Printy są reprodukowalne, więc **nie wchodzą do `piece_state`** i **nie podlegają rezerwacji** (`reserve_pieces`). Zawsze dostępne dopóki `published = true`. **Limity edycji (limited edition z licznikiem stocku) są zaprojektowane, ale ODŁOŻONE do fazy 2** (nowa tabela `print_stock`). → patrz *Otwarte pytania* p. 1.
2. **Osie wariantu są stałe i wspólne dla wszystkich projektów:** `size`, `paper`, `frame`. Konkretne wartości (np. A4/A3/A2, mat/satyna, bez ramy/rama dębowa/rama czarna) i ceny wymagają potwierdzenia przez studio. W planie używam wartości przykładowych, jasno oznaczonych jako placeholdery.
3. **Cena liczona wyłącznie serwerowo** z deterministycznej tablicy cen w `src/lib/print-pricing.ts`. Klient nigdy nie wysyła ceny — wysyła tylko token wariantu, identycznie jak dziś wysyła `id`. To zachowuje obecną ochronę przed manipulacją ceną.
4. **Brak Stripe Products/Prices.** Aplikacja już dziś liczy `amount` PaymentIntent serwerowo z katalogu — dokładamy się do tego wzorca, nie tworzymy drugiego źródła prawdy w Stripe.
5. **Brak CMS w MVP.** Printy definiujemy w kodzie (`src/lib/prints.ts`) + opisy w `messages/*.json` + obrazy przez `npm run optimize-images`, dokładnie jak ceramikę. Panel admina do wariantów jest opcjonalny (faza 3).
6. **Dwuwalutowość i i18n bez zmian koncepcyjnych:** `pl → PLN` (bez prefiksu), `en`/`es → EUR`. Ceny wariantów definiujemy w obu walutach (jak `PRICE_PLN`/`PRICE_EUR`), bo EUR nie jest mechanicznym przelicznikiem.
7. **Build pozostaje `next build --webpack`** — żadnych zmian w systemie budowania (Turbopack łamie runtime Workers).
8. **`slug` kategorii:** `fine-art-prints` (spójny z konwencją istniejących slugów, anglojęzyczny i bezkonfliktowy).

---

## Obecna architektura do sprawdzenia (ustalenia z analizy kodu)

| Obszar | Stan dzisiaj | Plik:linia | Konsekwencja dla printów |
|---|---|---|---|
| Typ produktu | `interface Product` — egzemplarz 1/1, jedna cena, `sold: boolean` | `src/lib/types.ts:20-38` | Nie pasuje do wariantów → osobny typ `PrintDesign`. |
| Slug kategorii | unia `CategorySlug` (9 wartości) | `src/lib/types.ts:8-17` | Dodać `'fine-art-prints'`. |
| Cennik | `PRICE_PLN`/`PRICE_EUR: Record<CategorySlug, number>`, `priceOf()` zwraca cenę per-kategoria | `src/lib/pricing.ts:4-14,49-72` | `Record<CategorySlug,…>` wymusi wpis dla nowej kategorii (placeholder „od"). Faktyczna cena printu liczona osobno. |
| Rejestr produktów | `buildProducts()` z `SPECS` + diff (REMOVED/RECATEGORISE/…) | `src/lib/products.ts` | Printy budujemy w osobnym rejestrze, nie przez `SPECS`. |
| Koszyk | Zustand `ids: string[]`, localStorage `acc_cart_v1`, brak ilości/wariantów | `src/store/cart.ts:11-29` | Zostaje `ids: string[]`; printy = tokeny złożone. |
| Walidacja koszyka | `validateCart(ids, currency)` → cena serwerowa z katalogu; `CheckoutItem = {product_id, unit_price}` | `src/lib/checkout.ts:8-35` | Rozgałęzić: bare id → ceramika; token → print. |
| Checkout | derywacja waluty z locale, `reserve_pieces` RPC **przed** PI, PaymentIntent z `amount`+`metadata`, zapis `orders`+`order_items` | `src/app/api/checkout/route.ts` | Rezerwować tylko ceramikę; printy pomijają `reserve_pieces`. |
| Stripe | klient bez `apiVersion`, fetch http client, `STRIPE_PMC_ID` stały; **brak** `stripe.products/prices` | `src/lib/stripe.ts`, `…/checkout/route.ts:18` | Bez zmian w modelu — dalej dynamiczny `amount`. |
| `order_items` | PK `(order_id, product_id)`, `unit_price`, brak wariantu/ilości | migracja `20260602213032_stripe_orders.sql:28-33` | Dodać `variant jsonb` (null = ceramika). |
| `piece_state` | 1 wiersz / `product_id`, `status` available\|reserved\|sold; wiersze seedowane migracjami | ta sama migracja `:6-11` | Printy **tu nie wchodzą** (open edition). |
| `reserve_pieces()` | atomowy lock `FOR UPDATE`, zwraca konflikty | ta sama migracja `:38-69` | Dla printów nie wołane. |
| **Webhook `markPaid` — strażnik liczby** | `fulfilledCount` (piece_state sold) vs `expectedCount` (order_items) — **jeśli mniej → REFUND + fail** | `src/app/api/stripe/webhook/route.ts:67-93` | **KRYTYCZNE:** print w `order_items` bez wiersza `piece_state` zaniży `fulfilledCount` → każde zamówienie z printem auto-refundowane. **Musi liczyć tylko ceramikę.** |
| PDP | wspólna trasa `(pdp)/[slug]/[id]`, `force-dynamic`, walidacja `category===slug`, `notFound()`; brak `loading.tsx` | `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` | Rozgałęzić render na print vs ceramika. |
| Kolekcje | 9 sztywnych stron `(collections)/<slug>/page.tsx` → `CollectionScreen` | `src/components/shop/CollectionScreen.tsx` | Dodać stronę `fine-art-prints` (kafle linkują do PDP, bez bezpośredniego add-to-cart). |
| Add-to-cart | wyspa `AddToCartButton`, `useCart.add(id)` | `src/components/shop/AddToCartButton.tsx` | Dla printów add następuje po wyborze wariantu (token). |
| i18n | `messages/{pl,en,es}.json`: `nav.*`, `collection.<slug>.*`, `notes.<slug>[i]`, `meta.collections.*` | — | Dodać klucze dla `fine-art-prints` + słownik osi wariantu. |
| Obrazy | `srcSet()` 400/800/1600w, WebP w `public/uploads/`, źródła w `design/uploads/` | `src/lib/images.ts` | Ten sam pipeline (hero + mockupy aranżacyjne). |
| Admin/CMS | **nie istnieje** (poza niewdrożonym read-only `/admin` z pamięci) | — | MVP: kod-driven. |

**Do zweryfikowania na starcie implementacji** (czytaj, nie zakładaj):
- `src/lib/products.ts` — pełny `buildProducts()`, `getProductById`, `getProducts`, `CATEGORIES`, `CATEGORY_ORDER`.
- `src/components/shop/ProductPageScreen.tsx` i `ProductPageGallery.tsx` — co realnie renderują (do reużycia w PDP printu).
- `src/lib/seo/structured-data.ts` — `productSchema()`/`collectionSchema()` (rozszerzymy o `AggregateOffer`).
- `src/components/shop/CartView.tsx` — render pozycji koszyka i pre-checkout reconcile (`/api/inventory`).
- `src/lib/inventory.ts` — `getSoldIds()` (printy nie partycypują).

---

## Proponowany model danych

### 1. Typy (`src/lib/types.ts`)

Dodajemy slug i **osobny typ** dla projektu printu (NIE dyskryminowana unia nad `Product` — to ograniczy blast radius do kodu print-specific):

```ts
export type CategorySlug =
  | 'kubki' | 'wazony' | 'wazony-srednie' | 'wazony-duze'
  | 'talerzyki' | 'talerze-srednie' | 'talerze-duze'
  | 'duze-michy' | 'miski-falowane'
  | 'fine-art-prints';            // NOWE

/** Osie wariantu printu. Wartości stałe, wspólne dla wszystkich projektów. */
export type PrintSize  = 'a4' | 'a3' | 'a2';                 // placeholder — potwierdzić
export type PrintPaper = 'matte' | 'satin';                  // placeholder — potwierdzić
export type PrintFrame = 'none' | 'oak' | 'black';           // placeholder — potwierdzić

export interface PrintVariantSelection {
  size: PrintSize;
  paper: PrintPaper;
  frame: PrintFrame;
}

/** Projekt printu fine art (reprodukowalny, konfigurowalny). */
export interface PrintDesign {
  /** Stabilny id, prefiks `fap`, np. `fap01`. */
  id: string;
  category: 'fine-art-prints';
  num: string;                    // numer wyświetlany w rodzinie
  image: string;                  // obraz główny (reprodukcja dzieła)
  gallery?: string[];             // mockupy aranżacyjne, detale papieru/ramy
  noteIndex: number;              // indeks do notes['fine-art-prints'][]
  /** Osie oferowane dla TEGO projektu (część globalnych może być wyłączona). */
  sizes: PrintSize[];
  papers: PrintPaper[];
  frames: PrintFrame[];
  /** Kombinacje wykluczone (np. brak ramy dla A2). Klucz = `${size}:${paper}:${frame}`. */
  unavailable?: string[];
  /** Czy projekt jest opublikowany (false = ukryty, niesprzedawalny). */
  published: boolean;
  /** Cena „od" w PLN — wyłącznie do listingu/sortowania/SEO. */
  fromPLN: number;
}
```

### 2. Reguła kombinacji rozmiar × papier × rama

- **Kanoniczny klucz wariantu (variantKey):** `` `${size}:${paper}:${frame}` `` (np. `a3:matte:oak`).
- **Token koszyka (cartToken):** `` `print:${designId}:${size}:${paper}:${frame}` `` (np. `print:fap01:a3:matte:oak`). Ceramika dalej jako bare id (`k01`).
- **SKU (deterministyczne, do faktur/etykiet):** `` `FAP-${num}-${SIZE}-${PAPER}-${FRAME}` `` (uppercase), np. `FAP-01-A3-MATTE-OAK`.
- **Dostępność kombinacji:** wariant jest sprzedawalny gdy `design.published && size∈sizes && paper∈papers && frame∈frames && !unavailable.includes(variantKey)`.

### 3. Cennik wariantu (`src/lib/print-pricing.ts`, nowy)

Model **baza + delty per oś**, z opcjonalnym nadpisaniem per-kombinacja (proste, czytelne, jedno źródło prawdy):

```ts
// Wszystkie kwoty: PLN i EUR w jednostkach głównych (jak PRICE_PLN/PRICE_EUR).
export const PRINT_SIZE_BASE = {
  a4: { pln: 120, eur: 29 },
  a3: { pln: 180, eur: 43 },
  a2: { pln: 260, eur: 62 },
} as const;                                   // placeholdery

export const PRINT_PAPER_DELTA = {
  matte: { pln: 0, eur: 0 },
  satin: { pln: 20, eur: 5 },
} as const;

export const PRINT_FRAME_DELTA = {
  none:  { pln: 0,   eur: 0 },
  oak:   { pln: 150, eur: 36 },
  black: { pln: 150, eur: 36 },
} as const;

/** Opcjonalne nadpisania per (designId, variantKey) — pełna kwota, nie delta. */
export const PRINT_PRICE_OVERRIDE: Record<string, { pln: number; eur: number }> = {};
```

`priceOfVariant(design, selection, currency)` zwraca kwotę w jednostkach głównych (PLN/EUR), a do Stripe konwertujemy `toGrosze`/`toEuroCents` jak dziś.

### 4. Pola, tabele, relacje (podsumowanie)

- **Nowe pola w kodzie:** `PrintDesign` + cenniki (wyżej). Brak zmian w `Product`.
- **DB — konieczne (faza 1):** kolumna `order_items.variant jsonb` (null = ceramika). Strażnik webhooka liczy tylko ceramikę.
- **DB — faza 2 (limited edition):** tabela `print_stock(design_id, variant_key, edition_total, sold_count)` + RPC `claim_print_units()`.
- **SKU/limity/status publikacji:** `published` i SKU w kodzie; limity edycji w `print_stock` (faza 2).
- **RLS/TS/zapytania:** RLS bez zmian (service-role omija; client nie ma dostępu). Typy TS rozszerzone jak wyżej. Zapytania webhooka i checkout — patrz niżej.

---

## Zmiany w Supabase

### Migracja A (KONIECZNA, faza 1): wariant w `order_items` + naprawa strażnika

Plik: `supabase/migrations/<ts>_order_items_variant.sql`

```sql
-- Print line items carry a chosen variant (size/paper/frame). NULL = one-of-a-kind ceramic.
alter table order_items add column variant jsonb;

-- The existing PK (order_id, product_id) blocks two print line items that share a
-- design id but differ by variant. Replace it with a surrogate id so multiple
-- variants of the same design can co-exist in one order.
alter table order_items add column id uuid not null default gen_random_uuid();
alter table order_items drop constraint order_items_pkey;
alter table order_items add primary key (id);
-- Keep ceramic dedup guarantee (one row per unique piece per order):
create unique index order_items_ceramic_unique
  on order_items (order_id, product_id)
  where variant is null;
```

> **Uwaga (strażnik liczby w `markPaid`):** po tej migracji `expectedCount` w webhooku **musi** liczyć tylko ceramikę: `…from('order_items').eq('order_id', orderId).is('variant', null)`. Bez tego każde zamówienie z printem wpadnie w `fulfilledCount < expectedCount` → auto-refund. To zmiana kodu (patrz *Checkout i zamówienia*), nie migracji — ale wynika z niej.

### Migracja B (OPCJONALNA, faza 2): limited edition

Plik: `supabase/migrations/<ts>_print_stock.sql`

```sql
create table print_stock (
  design_id     text not null,
  variant_key   text not null,            -- 'a3:matte:oak'
  edition_total integer not null,         -- np. 50
  sold_count    integer not null default 0,
  primary key (design_id, variant_key)
);
alter table print_stock enable row level security;  -- service-role only, jak reszta

-- Atomowe zajęcie N egzemplarzy; zwraca true gdy się zmieściło.
create or replace function claim_print_units(
  p_design text, p_variant text, p_qty integer
) returns boolean
language plpgsql
set search_path = public, pg_temp   -- (jak hardening reserve_pieces)
as $$
declare ok boolean;
begin
  update print_stock
     set sold_count = sold_count + p_qty
   where design_id = p_design and variant_key = p_variant
     and sold_count + p_qty <= edition_total
  returning true into ok;
  return coalesce(ok, false);
end; $$;
```

Faza 2 zmienia też webhook: po `payment_failed`/`refund` trzeba zwolnić zajęte egzemplarze (`sold_count -= qty`). W MVP (open edition) nic z tego nie istnieje.

### RLS / typy / zapytania

- **RLS:** bez nowych polityk — wszystko serwerowo przez `getSupabaseAdmin()`.
- **Typy TS:** rozszerzyć ewentualne typy generowane/lokalne `OrderItem` o `variant`.
- **Zapytania:** webhook (`markPaid` count guard, ładowanie `order_items` do maili/konwersji/faktury/InPost) — uwzględnić `variant` (label w mailu, opis w fakturze, opis pozycji w przesyłce).

---

## Zmiany w Stripe

- **Mapowanie wariantów:** **brak** obiektów Stripe Products/Prices. Każdy wariant to po prostu pozycja z policzoną serwerowo kwotą wchodzącą do sumy `amount` PaymentIntent — identycznie jak ceramika dziś.
- **Jeden produkt vs wiele encji:** N/D — nie używamy katalogu Stripe. To celowa decyzja (jedno źródło prawdy = nasz kod/DB, brak podwójnej synchronizacji). Gdyby w przyszłości potrzebny był Stripe Tax/feed, rozważyć Price objects — *Otwarte pytania* p. 5.
- **Metadata wariantu:** `metadata.product_ids` dalej działa, ale dla printów wstawiamy tokeny (`print:fap01:a3:matte:oak`). Uwaga na limit 500 znaków/wartość — przy wielu pozycjach skracać/agregować; **źródłem prawdy pozostają `orders`/`order_items`**, metadata jest pomocnicza. Opcjonalnie dodać `metadata.has_prints = '1'`.
- **Cena zależna od rozmiaru/papieru/ramy:** liczona w `validateCart` przez `priceOfVariant()` → `toGrosze`/`toEuroCents` → suma w `orderAmount*`.
- **Webhook/walidacja:** dwie zmiany (obie w `src/app/api/stripe/webhook/route.ts`):
  1. **`markPaid` count guard** liczy tylko ceramikę (`is('variant', null)`).
  2. **Fulfillment** (`createShipment`, `ensureInvoiced`, `trackPurchase`, maile) musi tolerować pozycje z `variant` (opis pozycji = projekt + rozmiar/papier/rama; bez mapowania na `piece_state`).
- **`apiVersion` ritual:** bez zmian — nie dotykamy wersji SDK ani snapshotu endpointu.

---

## Zmiany w frontendzie

1. **Routing/kategoria:**
   - `CategorySlug` += `'fine-art-prints'` (`src/lib/types.ts`).
   - `CATEGORIES['fine-art-prints']`, `CATEGORY_ORDER` += slug (`src/lib/products.ts`) — `price`/`measure`/`count` jako pola pomocnicze (cena = `fromPLN` „od").
   - `PRICE_PLN`/`PRICE_EUR` += wpis `'fine-art-prints'` = cena „od" (placeholder, udokumentowany jako display-only).
   - **`priceOf()`** w `src/lib/pricing.ts`: dla `category==='fine-art-prints'` zwraca cenę „od" (do kafli); pełna cena wariantu zawsze przez `priceOfVariant()`.
2. **Listing/kolekcja:**
   - Nowa strona `src/app/[locale]/(collections)/fine-art-prints/page.tsx` (wzór jak istniejące strony kolekcji).
   - Nowy lekki komponent listingu printów **lub** reużycie `CollectionScreen`/`Gallery` w trybie „kafel linkuje do PDP" (bez bezpośredniego add-to-cart — wariant trzeba wybrać). Kafel pokazuje „od X zł / from Y €".
3. **Nawigacja/hub `/sklep`:** dodać sekcję printów (lub świadomie pominąć w MVP — *Otwarte pytania* p. 4). Hreflang/sitemap automatycznie obejmą nową trasę przez istniejące helpery (`alternatesFor`, sitemap) — zweryfikować, że iterują po `CATEGORY_ORDER`.
4. **Koszyk (`CartView`):**
   - Renderować pozycje print: parsować token → label „Projekt — A3, satyna, rama dębowa" + cena z `priceOfVariant`.
   - **Reconcile `/api/inventory`** dotyczy tylko ceramiki (bare id) — pomijać tokeny `print:` (open edition zawsze dostępne; faza 2 doda osobny check).
5. **Spójność UX:** te same tokeny CSS (`tokens.css`), te same komponenty galerii/lightboxa, ten sam `AddToCartButton` (dla ceramiki), ta sama mechanika SelectionBar. Konfigurator to nowy, ale wizualnie zgodny element.

---

## Nowy PDP dla printów fine art

**Trasa:** ta sama `(pdp)/[slug]/[id]`. W `page.tsx` rozgałęzienie:
```ts
const print = getPrintById(id);
if (print && slug === 'fine-art-prints') return <PrintProductScreen design={print} />;
const product = getProductById(id);   // ceramika — bez zmian
```
Brak `loading.tsx` w grupie `(pdp)` zostaje (404 = realny 404).

**Komponenty (nowe):**
- `src/components/shop/PrintProductScreen.tsx` (RSC) — layout zgodny z `ProductPageScreen`: breadcrumb, `ProductPageGallery` (reużyty: reprodukcja + mockupy), `<h1>`, opis (`notes['fine-art-prints'][noteIndex]`), sekcja „więcej z kolekcji". Render wyspy konfiguratora.
- `src/components/shop/PrintConfigurator.tsx` (`'use client'`) — selektory `size`/`paper`/`frame` (radio/segmenty), **dynamiczna cena** z `priceOfVariant(design, sel, locale)`, blokowanie niedostępnych kombinacji (`disabled` + aria), przycisk „Dodaj do koszyka" wołający `useCart.add(cartToken)`. Analytics: `add_to_cart`/`select_item` z wariantem.

**Struktura treści PDP (sekcje):**
1. Galeria: reprodukcja dzieła (natywne proporcje, nigdy crop — zgodnie z regułą foto) + mockupy aranżacyjne + zbliżenia papieru/ramy.
2. Tytuł + krótki opis artystyczny.
3. Konfigurator (rozmiar → papier → rama) z ceną aktualizowaną na żywo i SKU/„od".
4. Szczegóły techniczne: wymiary druku per rozmiar, gramatura/typ papieru, technika druku (giclée?), opis ram.
5. Informacja o edycji (open edition / nakład — faza 2: „X z N").
6. Dostawa i czas realizacji (print-on-demand → dłuższy lead time niż ceramika gotowa od ręki!) + pielęgnacja (unikać słońca, oprawa pod szkłem itp.).
7. „Więcej z kolekcji printów".

**SEO / dane strukturalne:**
- `generateMetadata` per print (tytuł, opis, `alternates` hreflang dla 3 locale).
- JSON-LD `Product` z **`AggregateOffer`** (`lowPrice`=cena najtańszego wariantu, `highPrice`=najdroższego, `priceCurrency` per locale, `availability`), zamiast pojedynczego `Offer`. Rozszerzyć `productSchema()` w `src/lib/seo/structured-data.ts` o wariant „print".
- `BreadcrumbList` jak dla ceramiki.

---

## CMS/admin

**Decyzja MVP: kod-driven, bez nowego formularza.**
- Definicje printów: `src/lib/prints.ts` (`PRINT_DESIGNS: PrintDesign[]`).
- Opisy/tłumaczenia: `messages/{pl,en,es}.json` → `notes['fine-art-prints'][]`, `collection['fine-art-prints']`, plus słownik etykiet osi (`print.size.a3`, `print.paper.satin`, `print.frame.oak`).
- Obrazy: `design/uploads/fap-*.png` → `npm run optimize-images` → `public/uploads/*.webp` (hero + mockupy + detale papieru/ramy).
- Ceny/warianty: `src/lib/print-pricing.ts` + pola `sizes/papers/frames/unavailable` w `PrintDesign`.

**Faza 3 (opcjonalna) — panel admina printów:** formularz CRUD (projekt + macierz wariantów + upload do R2 + publikacja) **za bramką auth**. Uwaga z pamięci: istniejący lokalny `/admin` jest **bez auth i niewdrożony** — nie dokładać tu nic publicznie bez gate. To czyste rozszerzenie, nieblokujące MVP.

---

## Checkout i zamówienia

**Plik `src/lib/print-cart.ts` (nowy)** — kodowanie/dekodowanie tokenów + typy:
```ts
export const isPrintToken = (id: string) => id.startsWith('print:');
export function decodePrintToken(token: string): { designId: string; sel: PrintVariantSelection } | null { /* parse + walidacja enumów */ }
export function encodePrintToken(designId: string, sel: PrintVariantSelection): string { /* `print:...` */ }
export function variantLabel(sel, locale): string { /* do koszyka/maila */ }
```

**`validateCart` (`src/lib/checkout.ts`) — rozgałęzienie:**
```ts
for (const raw of rawIds) {
  if (typeof raw !== 'string' || seen.has(raw)) continue;
  if (isPrintToken(raw)) {
    const dec = decodePrintToken(raw);
    if (!dec) return { ok: false, reason: 'unknown' };
    const design = getPrintById(dec.designId);
    if (!design || !design.published || !isVariantAvailable(design, dec.sel)) return { ok:false, reason:'unknown' };
    const major = priceOfVariant(design, dec.sel, currency);   // PLN lub EUR
    const unit_price = currency === 'eur' ? toEuroCents(major) : toGrosze(major);
    items.push({ product_id: dec.designId, unit_price, variant: { ...dec.sel, sku: skuOf(design, dec.sel) } });
  } else {
    const product = getProductById(raw);
    if (!product) return { ok:false, reason:'unknown' };
    const unit_price = currency === 'eur' ? toEuroCents(PRICE_EUR[product.category]) : toGrosze(product.price);
    items.push({ product_id: raw, unit_price });   // variant: undefined
  }
  seen.add(raw);
}
```
`CheckoutItem` rozszerzyć o opcjonalne `variant?: { size; paper; frame; sku }`. `MAX_CART` — dziś `getProducts().length`; printy zwiększają teoretyczny limit → podbić bound (np. `getProducts().length + REASONABLE_PRINT_CART`, np. +20) lub zmienić na stałą sanity (np. 50).

**`/api/checkout/route.ts` — rozdzielenie rezerwacji:**
```ts
const ceramicIds = valid.items.filter(i => !i.variant).map(i => i.product_id);
// rezerwujemy TYLKO ceramikę:
if (ceramicIds.length) {
  const { data: conflicts } = await supabase.rpc('reserve_pieces', { p_ids: ceramicIds, p_order_id: orderId, p_ttl_secs: RESERVE_TTL_SECS });
  if (conflicts?.length) return NextResponse.json({ error:'unavailable', sold: conflicts }, { status:409 });
}
// (faza 2) printy limited edition: claim_print_units() per pozycja, z roll-backiem analogicznym do reserve.
// zapis order_items z variant:
await supabase.from('order_items').insert(valid.items.map(i => ({ order_id: orderId, product_id: i.product_id, unit_price: i.unit_price, variant: i.variant ?? null })));
```
`amount` liczone z `valid.items` jak dziś (suma `unit_price` + shipping). Rollback przy błędzie PI/persist — uwzględnić, że dla ceramiki czyścimy `piece_state` po `order_id` (bez zmian), a printy nie wymagają czyszczenia w MVP.

**Webhook (`markPaid`) — naprawa strażnika (KRYTYCZNE):**
```ts
const { count: expectedCount } = await supabase
  .from('order_items').select('*', { count:'exact', head:true })
  .eq('order_id', orderId).is('variant', null);     // tylko ceramika
```
`fulfilledCount` (piece_state sold) zostaje. Dzięki temu zamówienia print-only mają `expected=0, fulfilled=0` → przechodzą; mieszane porównują tylko część ceramiczną.

**Zapis finalnej konfiguracji w zamówieniu:** w `order_items.variant` (size/paper/frame/sku) + `unit_price` w walucie zamówienia. To trwały, audytowalny rekord (faktura, etykieta, reklamacje).

**Brak rozjazdu ceny FE/Supabase/Stripe:** FE wyświetla cenę z `priceOfVariant` tylko poglądowo; **jedyne** miejsce liczące kwotę do zapłaty to `validateCart` (serwer) → ta sama funkcja → ta sama tablica `print-pricing.ts`. Stripe dostaje policzone `amount`. Brak drugiego źródła prawdy.

**Walidacja wariantu przed płatnością:** `decodePrintToken` (poprawność enumów) + `isVariantAvailable` (publikacja + oferowane osie + `unavailable`) w `validateCart`; nieprawidłowy token → 400 `unknown`.

---

## Testy

**Jednostkowe (Vitest, `src/**/*.test.ts`):**
- `print-cart.test.ts`: encode/decode round-trip; odrzucenie złych tokenów (zły enum, brak osi, nieznany design).
- `print-pricing.test.ts`: `priceOfVariant` PLN i EUR dla reprezentatywnych kombinacji; nadpisania `PRINT_PRICE_OVERRIDE`; spójność z `toGrosze/toEuroCents`.
- `prints.test.ts`: `getPrintById`, stabilność id, `isVariantAvailable` (oferowane osie + `unavailable` + `published=false`).
- `checkout.test.ts` (rozszerzyć): koszyk mieszany ceramika+print → poprawne `unit_price` i `variant`; nieznany token → `unknown`; print niepublikowany → `unknown`; suma `amount` poprawna.
- `structured-data.test.ts`: `AggregateOffer` low/high/currency.

**Integracyjne (handler webhooka z wstrzykniętymi zależnościami):**
- `markPaid` dla zamówienia **print-only** (expected=0) → NIE refunduje, status `paid`.
- `markPaid` dla zamówienia **mieszanego**, gdy ceramika sprzedana poprawnie → przechodzi; gdy brakuje wiersza ceramiki → refund (zachowane stare zabezpieczenie).
- `releaseHold`/`releaseSale` nie psują się przy pozycjach z `variant` (brak mapowania na piece_state).
- maile/faktura/InPost: pozycja print ma sensowny label (size/paper/frame), nie tylko `product_id`.

**E2E (Playwright):**
- `print-configurator.spec.ts`: PDP printu → wybór wariantu → cena aktualizuje się → niedostępna kombinacja zablokowana → dodaj do koszyka → token w koszyku z poprawną ceną.
- `purchase-print.spec.ts` (wzór istniejących checkout-edge): pełny checkout printu (test mode) → PaymentIntent z poprawną kwotą → webhook → `order_items.variant` zapisany, brak auto-refundu.
- `purchase-mixed.spec.ts`: ceramika + print w jednym koszyku → ceramika rezerwowana, print nie → oba w zamówieniu.
- Regresja: istniejące spec'i ceramiki przechodzą bez zmian.

**Poprawność ceny (krytyczny przypadek):** test, że kwota PaymentIntent == suma `priceOfVariant` (serwer) + shipping, dla koszyka mieszanego w PLN i EUR.

---

## Ryzyka

**Techniczne:**
1. **Auto-refund strażnikiem webhooka** (gdyby zapomnieć `is('variant', null)`) — każde zamówienie z printem refundowane. *Mitygacja:* test integracyjny print-only jako gate.
2. **PK `order_items (order_id, product_id)`** blokuje dwa warianty tego samego projektu w jednym zamówieniu. *Mitygacja:* surrogate `id` + częściowy unique index (Migracja A).
3. **Reconcile koszyka / `getSoldIds`** mylnie usuwałby tokeny print. *Mitygacja:* filtrować `isPrintToken`.
4. **`Record<CategorySlug,…>`** w wielu miejscach wymusi wpisy dla nowej kategorii — kompilacja wskaże braki (dobre), ale trzeba przejść wszystkie (`PRICE_PLN`, `PRICE_EUR`, `CATEGORIES`, ewentualne mapy SEO/i18n). *Mitygacja:* `tsc` jako checklista.
5. **Metadata Stripe 500 znaków** przy wielu tokenach. *Mitygacja:* agregacja/`has_prints`, źródło prawdy w DB.
6. **Lead time / wysyłka ram** — ramy są cięższe/kruche; obecne stawki shipping (paczkomat/kurier) i InPost mogą nie pasować dla oprawionych printów. *Mitygacja:* potwierdzić logistykę (*Otwarte pytania* p. 3).
7. **`force-dynamic` PDP + brak loading.tsx** — print z nieprawidłowym slugiem musi dać realny 404 (zachować wzór).

**Produktowe:**
8. **Decyzja open vs limited edition** zmienia zakres DB (tabela + RPC + rollback). Zła decyzja = przeróbka. *Mitygacja:* MVP open edition, faza 2 zaprojektowana.
9. **Eksplozja kombinacji** (rozmiary×papiery×ramy) — przy macierzy cen baza+delty unikamy ręcznego wypisywania; `unavailable` obsługuje wyjątki.
10. **Spójność wizualna konfiguratora** z resztą sklepu (AI-slop risk). *Mitygacja:* trzymać tokeny/komponenty, przegląd designu.
11. **Treść/tłumaczenia** osi wariantu i opisów papieru/ram w 3 językach — koszt redakcyjny.

---

## MVP (minimalny zakres pierwszego release'u)

**W zakresie:**
- Kategoria `fine-art-prints` w typach/routing/i18n/nav.
- Rejestr `PrintDesign` + `print-pricing` (open edition, `published`).
- Strona kolekcji printów (kafle „od X" linkujące do PDP).
- PDP printu + konfigurator (size/papier/rama) z dynamiczną ceną i blokadą niedostępnych kombinacji.
- Koszyk obsługuje tokeny print (label + cena), reconcile pomija printy.
- Checkout: wycena serwerowa wariantu, zapis `order_items.variant`, rezerwacja tylko ceramiki.
- **Migracja A** + **naprawa strażnika webhooka**.
- Fulfillment toleruje printy (mail/faktura/InPost z labelem wariantu).
- SEO: `AggregateOffer`, hreflang, sitemap.
- Testy: jednostkowe + integracyjne webhooka + E2E checkout printu i mieszany.

**Poza MVP (później):**
- Limited edition (`print_stock` + `claim_print_units` + rollback) — *faza 2*.
- Panel admina printów za auth — *faza 3*.
- Sekcja printów w hubie `/sklep` (jeśli odłożona).
- Zaawansowana logistyka ram (osobne stawki/lead time).
- Ewentualne Stripe Price objects (gdyby wszedł Stripe Tax/feed).

---

## Etapy implementacji

> Każde zadanie: TDD (test → uruchom (fail) → minimalna implementacja → uruchom (pass) → commit). Ścieżki dokładne. Build zawsze `next build --webpack`. Subagentom: **żadnych operacji git poza wskazanymi commitami** (kontroler commituje po ścieżkach).

### Etap 0 — Fundament typów i cennika (bez UI)
1. `src/lib/types.ts`: dodać `'fine-art-prints'` do `CategorySlug`, dodać `PrintSize/Paper/Frame`, `PrintVariantSelection`, `PrintDesign`. (TDD: test kompilacji + smoke.)
2. `src/lib/pricing.ts`: dodać wpisy `'fine-art-prints'` do `PRICE_PLN`/`PRICE_EUR` (cena „od", placeholder), zaktualizować komentarz `priceOf` (print → „od").
3. `src/lib/print-pricing.ts` (nowy) + `print-pricing.test.ts`: `PRINT_SIZE_BASE/PAPER_DELTA/FRAME_DELTA/PRICE_OVERRIDE`, `priceOfVariant(design, sel, currency)`. Test: PLN/EUR/override.
4. `src/lib/prints.ts` (nowy) + `prints.test.ts`: `PRINT_DESIGNS` (1–2 projekty przykładowe), `getPrintById`, `getPrintDesigns`, `skuOf`, `isVariantAvailable`. Test: stabilność id, dostępność.
5. `src/lib/print-cart.ts` (nowy) + `print-cart.test.ts`: `isPrintToken`, `encode/decodePrintToken`, `variantLabel`. Test: round-trip + złe tokeny.
6. Commit: „feat(prints): typy, rejestr i cennik wariantów (open edition)".

### Etap 1 — Checkout serwerowy (rdzeń bezpieczeństwa ceny)
7. `src/lib/checkout.ts`: rozszerzyć `CheckoutItem` o `variant?`, rozgałęzić `validateCart` (token vs bare id), podbić/zmienić `MAX_CART`. (TDD: `checkout.test.ts` — mieszany koszyk, nieznany/niepublikowany token, suma.)
8. `src/app/api/checkout/route.ts`: rezerwować tylko `ceramicIds`; zapis `order_items` z `variant`; rollback bez czyszczenia printów. (Test: jednostkowy helpera split + ręczna weryfikacja.)
9. Commit: „feat(prints): wycena i checkout wariantów, rezerwacja tylko ceramiki".

### Etap 2 — DB + webhook (eliminacja auto-refundu)
10. Migracja A `<ts>_order_items_variant.sql` (kolumna `variant`, surrogate PK, partial unique index).
11. `src/app/api/stripe/webhook/route.ts`: `expectedCount` z `.is('variant', null)`; ładowanie `order_items` z `variant` do maili/faktury/InPost; labelowanie pozycji print. (TDD: integracyjny `markPaid` print-only + mieszany.)
12. Commit: „fix(prints): strażnik fulfillmentu liczy tylko ceramikę; wariant w order_items".

### Etap 3 — Frontend: kategoria + listing
13. `src/lib/products.ts`: `CATEGORIES['fine-art-prints']`, `CATEGORY_ORDER += slug`.
14. `messages/{pl,en,es}.json`: `nav`, `collection['fine-art-prints']`, `notes['fine-art-prints']`, słownik `print.size/paper/frame.*`, `meta.collections`.
15. `src/app/[locale]/(collections)/fine-art-prints/page.tsx` (+ metadata/hreflang/JSON-LD kolekcji). Reużyć `CollectionScreen`/`Gallery` lub lekki listing „od X → PDP".
16. Weryfikacja sitemap/hreflang obejmuje nową trasę. Commit.

### Etap 4 — PDP + konfigurator
17. `src/components/shop/PrintConfigurator.tsx` (`'use client'`) — selektory, dynamiczna cena, blokada `unavailable`, add-to-cart token, analytics. (E2E `print-configurator.spec.ts`.)
18. `src/components/shop/PrintProductScreen.tsx` (RSC) — layout + galeria + opis + sekcje techniczne/edycja/dostawa/pielęgnacja + „więcej z kolekcji".
19. `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx`: rozgałęzienie print vs ceramika; `generateMetadata` dla printu.
20. `src/lib/seo/structured-data.ts`: `AggregateOffer` dla printu. Commit.

### Etap 5 — Koszyk + spójność + E2E
21. `src/components/shop/CartView.tsx`: render pozycji print (label+cena), reconcile pomija tokeny print.
22. CSS: style konfiguratora w istniejącym `site.css` (zgodne z tokenami).
23. E2E: `purchase-print.spec.ts`, `purchase-mixed.spec.ts`; regresja ceramiki.
24. `npm run lint`, `npm run test`, `npm run build` (webpack), `npm run preview:cf` smoke. Commit + handoff do review.

### Etap 6 (faza 2, opcjonalny) — Limited edition
25. Migracja B `print_stock` + `claim_print_units`; integracja w checkout + rollback w webhook (`payment_failed`/`refund`); badge „X z N" w PDP/konfiguratorze; reconcile dostępności printów.

---

## Otwarte pytania

> **Decyzje (2026-06-13, właściciel):**
> - **p.1 — OPEN EDITION wybrane na stałe.** Printy zostają open edition (bez stocku, bez numeracji „X z N"). **Faza 2 (limited edition: tabela `print_stock` + RPC `claim_print_units()` + rollback w webhooku + badge nakładu + reconcile dostępności) jest ANULOWANA — nie „odłożona".** Etap 6 / Migracja B nie wchodzą. Nie budować spekulacyjnie.
> - **p.2 — osie/ceny: placeholdery zostają.** Realne projekty/ceny/obrazy dostarcza studio „za parę dni"; do tego czasu pracujemy na placeholderach (obrazy `fap-*.webp` wygenerowane jako placeholdery dev — patrz `scripts/gen-print-placeholders.mjs`).
> - **p.3 — logistyka ram: NADAL OTWARTE** (decyzja produktowa/operacyjna, nie inżynierska).
> - **p.7 — admin (Faza 3): pozostaje opcjonalny/odłożony**, nie blokuje MVP.

1. **Edycja: open czy limited?** ~~MVP zakłada **open edition**…~~ → **ROZSTRZYGNIĘTE: open edition na stałe (Faza 2 anulowana).**
2. **Konkretne osie i wartości:** finalne rozmiary (A4/A3/A2? większe?), rodzaje papieru (mat/satyna/bawełniany giclée?), opcje ram (kolory/materiały) oraz **ceny PLN i EUR** dla baz i delt. W planie placeholdery.
3. **Logistyka ram:** czy oprawiony print ma inny koszt/sposób wysyłki i dłuższy lead time niż ceramika? Czy obecne metody (paczkomat/kurier InPost) obsłużą oprawione, kruche przesyłki, czy potrzeba osobnej stawki/kuriera?
4. **Hub `/sklep`:** czy printy mają pojawić się w zbiorczym `/sklep` (scroll-spy) w MVP, czy tylko jako osobna kolekcja?
5. **Stripe katalog:** zostajemy przy dynamicznym `amount` (rekomendacja). Czy planowany jest Stripe Tax / product feed, który wymagałby Price objects? Jeśli nie — zamykamy temat.
6. **Faktury i nazewnictwo pozycji:** jak ma brzmieć opis pozycji print na fakturze i etykiecie (np. „Print fine art «Tytuł» — A3, papier satynowy, rama dębowa, SKU FAP-01-A3-SATIN-OAK")?
7. **Admin:** czy potrzebny jest w ogóle panel do samodzielnego dodawania printów (faza 3), czy model kod-driven (jak ceramika) wystarcza długoterminowo?
8. **Treść/pielęgnacja/edycja:** kto dostarcza opisy techniczne, instrukcje pielęgnacji i teksty marketingowe w 3 językach?
```

---

## Self-review plan

**Spec coverage:** wszystkie 9 obszarów z polecenia (model danych, Stripe, frontend, CMS/admin, PDP+content, checkout, infrastruktura, testy+ryzyka, plan wdrożenia) + wszystkie wymagane sekcje obecne. ✅
**Placeholder scan:** ceny/osie świadomie oznaczone jako placeholdery z odesłaniem do *Otwartych pytań* — to nie luki planu, lecz decyzje produktowe. ✅
**Type consistency:** `cartToken` `print:<id>:<size>:<paper>:<frame>`, `variantKey` `size:paper:frame`, `priceOfVariant`, `decodePrintToken`, `isVariantAvailable`, `order_items.variant`, `is('variant', null)` — spójne w całym dokumencie. ✅
