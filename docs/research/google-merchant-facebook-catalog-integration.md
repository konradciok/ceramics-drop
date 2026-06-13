# Research: integracja katalogu produktów z Google Merchant Center, Google Ads i Meta (Facebook/Instagram) Catalog

> **Cel dokumentu.** Deep research pod przyszłą specyfikację i plan wdrożenia programatycznego zarządzania katalogiem produktów tego sklepu (Next.js 16 / OpenNext / Cloudflare Workers) w Google Merchant Center, Google Ads oraz Meta Commerce. Dokument jest punktem wyjścia dla osobnej sesji „spec + plan" — **nie jest planem wdrożenia**, jest źródłem faktów + mapowaniem na realny model danych repo.
>
> - **Data researchu:** 2026-06-12
> - **Stan:** Research zakończony; część twierdzeń zweryfikowana adwersaryjnie (harness deep-research, głosowanie 3×), część uzupełniona przez agentów web-research z cytatami do źródeł pierwotnych.
> - **Zakres weryfikacji:** rdzeń Google Merchant API zweryfikowany głosowaniem; Meta Catalog, Google Ads linking, EU/PL compliance — cytaty do źródeł pierwotnych, poziom pewności oznaczony inline.
> - **Powiązane dokumenty repo:** [`AGENTS.md`](../../AGENTS.md), [`docs/analytics-stack.md`](../analytics-stack.md), [`docs/cloudflare-deployment.md`](../cloudflare-deployment.md).

---

## 0. TL;DR — rekomendacja w jednym akapicie

W 2026 buduj na **Google Merchant API v1** (GA od lipca 2025), **nie** na Content API for Shopping (wyłączenie **18 sierpnia 2026**; v1beta już martwe od 28 lutego 2026). Model jest **API-driven**: tworzysz zapisywalny zasób `ProductInput` (insert/patch/delete) wysyłany do **data source typu `API`**, a Google łączy go z regułami i feedami uzupełniającymi w read-only `Product`. Katalog (Merchant Center) i kampanie (Google Ads) to **dwie różne warstwy** — do publikacji katalogu Google Ads API **nie jest potrzebne**; jest potrzebne dopiero do automatyzacji Performance Max / Shopping. Po stronie Meta: jeden katalog + **`items_batch`** (REST, `CREATE/UPDATE/DELETE`) do push-updateów, override-feedy do lokalizacji. **Na Cloudflare Workers nie używaj ciężkich Node-SDK** (`googleapis` z http2, `google-ads-api`/oficjalny klient z gRPC, `facebook-nodejs-business-sdk` z `node:http`) — wszystko rób przez **czysty REST + `fetch`**. Podpis JWT konta serwisowego Google możesz zrobić zarówno przez `node:crypto` (pełne API dostępne na Workers od kwietnia 2025; repo ma już `nodejs_compat` + `compatibility_date: 2026-06-02`), jak i przez **WebCrypto** (`crypto.subtle`, rekomendowane przez Cloudflare Best Practices) — **wcześniejszy „bloker podpisu" już nie obowiązuje.** Push `availability=out_of_stock` z **webhooka Stripe** to dobry wzorzec, ale **nie jest natychmiastowy** — propagacja do `Product` trwa zwykle kilka minut (więc nie obiecuj „realtime sold-out" w reklamach; UX „sprzedane = niedostępne" zapewnia natomiast natychmiast `piece_state`/`getSoldIds`, niezależnie od feedu).

**Rekomendowany stack bibliotek (Workers-safe):**

| Warstwa | Rekomendacja | Uwaga |
|---|---|---|
| Google auth (service account → access token) | `crypto.subtle` (WebCrypto RS256) **lub** `node:crypto` `sign()` — oba działają na Workers | `node:crypto` pełne API od kwietnia 2025; CF Best Practices zaleca WebCrypto. `@sagi.io/workers-jwt` opcjonalnie, ale niszowy — preferuj własny helper |
| Google Merchant API | czysty REST (`fetch` → `merchantapi.googleapis.com`) | `googleapis` Node SDK = ryzyko bundlowania (http2), niepotrzebne dla samego REST |
| Google Ads API (kampanie, faza 2) | czysty REST (`googleads.googleapis.com/v{N}/...`) | `google-ads-api` (Opteo) i oficjalny klient używają gRPC — **nie działają na Workers** |
| Meta Catalog | czysty REST (`fetch` → `graph.facebook.com/v{N}/{catalog_id}/items_batch`) | `facebook-nodejs-business-sdk` zależy od `node:http(s)` — niepotrzebne, to JSON-over-HTTPS |
| XML feed (fallback / bootstrap / Meta scheduled) | własny generator stringów w route handlerze | brak potrzeby zewn. biblioteki |

---

## 0.5. Rozstrzygnięte decyzje (product owner, 2026-06-12) — wejście zablokowane pod spec

> Odpowiedzi właściciela na Open Questions z pierwotnego researchu. Tam gdzie padło „wg rekomendacji", podaję konkretną rekomendację z uzasadnieniem — to jest decyzja, chyba że spec ją zmieni.

| # | Pytanie | Rozstrzygnięcie |
|---|---|---|
| 1 | Model wariantów printów | **Printy są reprodukowalne (stock > 1, np. 10 szt/wariant), nie unikaty.** 3 osie wariantów: **rozmiar (4) × papier (2) × oprawa (2) = do 16 wariantów** na jeden print. Ta sama kategoria produktu, **cena per wariant**, **stan per wariant**. Patrz przeprojektowany §6. |
| 2 | Kraje / waluty | **EU + UK.** Stripe obsługuje wielowalutowość → **trzy waluty: PLN (PL), EUR (EU), GBP (UK).** UK to osobny target regulacyjny (post-Brexit). Patrz zaktualizowany §4 i §11. |
| 3 | VAT | **Ceny są VAT-inclusive (brutto).** `PRICE_PLN`/`PRICE_EUR` to ceny brutto; dla GBP trzeba dodać brutto-cennik. Spełnia wymóg Google/Meta dla EU+UK. |
| 4 | `google_product_category` | **Wg propozycji w §2.2** (zablokowane; finalne GPC ID do potwierdzenia przy implementacji w UI MC). |
| 5 | Token Meta | **Permanentny token już istnieje** — nie trzeba projektować refreshu. (Trzymać jako runtime secret; monitorować ewentualne wymuszenie wygasania przez Meta.) |
| 6 | Rozmiar sekretu SA JSON na Workers | **Mieści się — limit to 5 KB na sekret** ([CF docs](https://developers.cloudflare.com/workers/platform/limits/)); GCP SA JSON to ~2–2,5 KB. **Nie trzeba rozbijać** — jeden sekret `GOOGLE_SA_JSON`. |
| 7 | Cykl usuwania sprzedanych z feedu | **Rekomendacja:** (a) UX twardo — sprzedane natychmiast niedostępne (już zapewnia `piece_state`/`getSoldIds`, niezależnie od feedu); (b) na sprzedaż → natychmiast push `out_of_stock` (Google+Meta) z webhooka; (c) nocny cron `delete` z feedu pozycji sprzedanych **> 48 h** (okno na dogaszenie remarketingu, mniejszy churn feedu), PDP zostaje żywy z `SoldOut`. Dla printów: `delete` dopiero gdy **cała grupa** wyprzedana; pojedynczy wariant z `stock=0` → `out_of_stock`, grupa żyje póki inny wariant dostępny. |
| 8 | SDK na OpenNext | **REST-only, twardo.** Bez testów bundlowania `googleapis`/`@google-shopping/*`. |
| 9 | Macierz `nodejs_compat` | **Zweryfikowane:** repo ma `nodejs_compat` + `compatibility_date: 2026-06-02`; **pełne `node:crypto` (sign/verify) i `node:tls` dostępne od 2025-04-08.** Podpis JWT nie jest blokerem (patrz korekta §8). |
| 10 | Google Ads API w zakresie? | **TAK, w zakresie** — ale jako **faza 2** (automatyzacja PMax/Shopping), po dostarczeniu katalogu w fazie 1. |
| 11 | Audyt stron prawnych pod MC | **W zakresie** — osobny task w spec (zwroty/dostawa/regulamin/prywatność/kontakt + weryfikacja tożsamości + CSS). Patrz §11. |
| 12 | Spójność `availability` JSON-LD↔feed | **Rekomendacja:** jedno źródło prawdy (`getSoldIds()` + stan wariantów printów) → wspólny builder produkujący neutralny `availability` (`available`/`sold`), a mapowanie na `schema.org/InStock\|SoldOut` (JSON-LD) i `in_stock\|out_of_stock`/`in stock\|out of stock` (Google/Meta) **tylko w adapterach na brzegu.** Patrz §12. |
| 13 | Max batch Meta | **Nieautorytatywne** (5000 niepotwierdzone w źródle pierwotnym). **Rekomendacja:** chunkuj po **1000 pozycji/request** — bezpiecznie poniżej każdego prawdopodobnego limitu; przy rozmiarze tego katalogu (~100–200 + warianty) i tak bez znaczenia. |
| 14 | Reconcile vs idempotencja | **Rekomendacja:** **DB (`piece_state` + rejestr printów) jest jedynym źródłem prawdy**; Google/Meta to *projekcje*. Webhook robi delty (autorytatywne dla zdarzeń sprzedaży); nocny cron robi **pełny deterministyczny re-assert** całego stanu (idempotentny insert/patch + delete brakujących). Nigdy „read-back-modify" z MC — zawsze nadpisuj stanem z DB, co samoistnie naprawia drift i wyścigi (ostatni piszący = stan DB). |

### Konsekwencje, które zmieniają architekturę względem pierwotnego researchu

1. **Trzy waluty, nie dwie.** `pricing.ts` ma dziś tylko PLN/EUR. Dochodzi **GBP** dla UK → nowy cennik `PRICE_GBP` (brutto) + rozszerzenie `priceOf()` o mapę locale/kraj→waluta. UK jest osobnym targetem GMC (własny `feedLabel`, własne wymogi).
2. **Dwa modele dostępności w jednym katalogu.** Ceramika = unikaty (1 szt, `sold` boolean). Printy = **stan ilościowy per wariant** (`stock: number`). Generator katalogu musi obsłużyć oba: ceramika → `in_stock`/`out_of_stock` z `getSoldIds()`; print-wariant → `in_stock` gdy `stock>0`, inaczej `out_of_stock`.
3. **Printy wymagają nowego modelu danych + tabeli stanu.** `products.ts` i `piece_state` (PK = `product_id`, status unikatowy) nie modelują wariantów ani ilości. To największa praca projektowa fazy spec — patrz §6.
4. **Faza 1 = katalog (Google MC + Meta) dla ceramiki + printów; Faza 2 = Google Ads API (kampanie).**

---

## 1. Architektura feedu / katalogu: statyczny feed vs API-driven

### 1.1. Wybór API: Merchant API v1 (nie Content API for Shopping)

- **Merchant API v1 jest GA od lipca 2025** i jest oficjalnym następcą Content API for Shopping. *(pewność: wysoka, głos 3-0)*
- **Content API for Shopping zostaje wyłączone 18 sierpnia 2026.** *(wysoka)*
- **Merchant API v1beta zostało wyłączone 28 lutego 2026** — wszystkie wywołania muszą iść na `v1` (lub `v1alpha` dla funkcji eksperymentalnych). *(wysoka, 3-0)*
- Źródło pierwotne: <https://developers.google.com/merchant/api/latest-updates> (potwierdzone wtórnie: Search Engine Land, SEJ, PPC Land).

**Wniosek:** każdy nowy kod od razu na Merchant API v1. Nie inwestować w Content API.

### 1.2. Model API-driven: `ProductInput` → `Product`

- `ProductInput` to **dane wejściowe które wysyłasz** (raw, zapisywalne), nie przetworzony produkt. Metody: **`insert`, `delete`, `patch`** — granularny CRUD per pozycja, zamiast podmiany całego feedu. *(wysoka, 3-0)*
- Google łączy: `ProductInput` (jeden primary) + reguły feedu + supplemental data sources → read-only **`Product`** (to, co realnie trafia do Shopping/free listings). *(wysoka)*
- **Aby pisać programatycznie, najpierw utwórz data source typu `API`.** `productInputs.insert/patch/delete` działają **tylko** na źródłach typu `API`, nie na plikowych/feedowych. *(wysoka, 2-1)*
- Źródła: <https://developers.google.com/merchant/api/guides/products/overview>, <https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs>, <https://developers.google.com/merchant/api/guides/products/add-manage>, <https://developers.google.com/merchant/api/guides/data-sources/api-sources>.

### 1.3. Statyczny feed XML/Sheets — kiedy mimo wszystko

Statyczny content feed (XML/RSS 2.0 / Google Sheets / hostowany plik) jest nadal wspierany i bywa prostszy na start, ale:
- nie daje granularnego push-updatu (tylko cały feed na harmonogram),
- gorszy dla **unikatowego inventory** (sprzedaż jednej sztuki → chcesz natychmiast `out_of_stock`, a nie czekać na re-fetch feedu).

**Rekomendacja dla tego repo:** docelowo **API-driven** (Merchant API + push z webhooka). XML feed warto utrzymać jako:
1. **bootstrap / disaster-recovery** (pełny re-sync katalogu),
2. **feed dla Meta** (Meta świetnie konsumuje hostowany plik na harmonogramie — patrz §3),
3. ewentualny fallback gdy API niedostępne.

To znaczy: jeden generator danych produktowych, dwa „ujścia" — REST push (Google + Meta realtime) i hostowany plik (`/api/feed/google.xml`, `/api/feed/facebook.xml`).

---

## 2. Specyfikacja atrybutów Google Merchant Center + mapowanie `products.ts`

### 2.1. Tożsamość pozycji (kluczowe dla i18n/multi-currency)

- Każdy `ProductInput` wymaga: **`offerId`**, **`contentLanguage`** (dwuliterowy ISO 639-1), **`feedLabel`**. *(wysoka, 3-0)*
- Nazwa zasobu = `accounts/{account}/productInputs/{contentLanguage}~{feedLabel}~{offerId}` (np. `en~US~sku123`). *(wysoka, 3-0)*
- **Ten sam `id`/`offerId` dla tego samego produktu w różnych krajach/językach.** *(wysoka, 3-0)*

**Konsekwencja dla sklepu pl/en/es:** jeden fizyczny przedmiot = **jeden stabilny `offerId` (= `product.id` z `products.ts`, np. `k01`)**, ale **wiele `ProductInput`** — po jednym na kombinację język×kraj/waluta. Przykładowo:
- `pl~PL~k01` (PLN, polski)
- `en~EU~k01` lub `en~DE~k01` (EUR, angielski)
- `es~ES~k01` (EUR, hiszpański)

(`feedLabel` to dowolny string ≤ 20 znaków; mapuj go na kraj/grupę walutową — patrz §4 i §11.)

### 2.2. Tabela atrybutów GMC + mapowanie z modelu repo

> Model źródłowy: [`src/lib/products.ts`](../../src/lib/products.ts) (`Product`: `id`, `category`, `num`, `image`, `gallery?`, `price` PLN, `measure`, `sold`, `noteIndex`), ceny w [`src/lib/pricing.ts`](../../src/lib/pricing.ts) (`PRICE_PLN`/`PRICE_EUR` per kategoria, `priceOf()`), stan sold w [`src/lib/inventory.ts`](../../src/lib/inventory.ts) (`getSoldIds()`), treści i18n w `messages/{pl,en,es}.json` (`notes.{category}[noteIndex]`).

| Atrybut GMC | Wymag. | Źródło w repo / sposób wygenerowania | Uwagi |
|---|---|---|---|
| `id` (offerId) | **wymagany** | `product.id` (stabilny token `k01`…) | ✅ idealnie pasuje — stabilny, nie renumeruje się |
| `title` | **wymagany** | `${singular} Nº ${num}` z i18n (jak w `productSchema()`) | per `contentLanguage`; ≤150 znaków |
| `description` | **wymagany** | `notes.{category}[noteIndex]` z `messages/{locale}.json` | per język; bez HTML |
| `link` | **wymagany** | `absoluteUrl(locale, '/${category}/${id}')` | musi być crawlowalny (patrz §12) |
| `image_link` | **wymagany** | `${SITE_URL}${product.image}` (WebP) | min 250×250 (odzież 500×500); WebP akceptowany |
| `additional_image_link` | zalecany | `product.gallery[]` → `${SITE_URL}${img}` | do 10 dodatkowych |
| `availability` | **wymagany** | `getSoldIds()` → `in_stock` / `out_of_stock` | **MUSI zgadzać się z JSON-LD na stronie** (patrz §5, §12) |
| `price` | **wymagany** | `priceOf(product, locale)` + waluta; `pl→PLN`, reszta `EUR` | **VAT-inclusive dla EU** (§11); format `"95.00 PLN"` / `"25.00 EUR"` |
| `sale_price` | opcjonalny | obecnie brak promocji w modelu | dołożyć gdy pojawią się przeceny |
| `brand` | warunkowy | stała `"Anna Ciok"` (nazwa artystki/studia) | przy handmade pełni rolę identyfikatora |
| `gtin` | warunkowy | **brak** — ceramika nie ma GTIN | nie wymyślać GTIN! |
| `mpn` | warunkowy | opcjonalnie `product.id` jako wewn. identyfikator | zalecane dla handmade |
| `identifier_exists` | warunkowy | **`no`** dla całej ceramiki | patrz §2.3 |
| `condition` | wymagany | stała `new` | nowe przedmioty handmade |
| `product_type` | zalecany | własna ścieżka, np. `Ceramika > Kubki` | własna taksonomia, wpływa na klasyfikację |
| `google_product_category` | zalecany | stała mapa per kategoria (patrz niżej) | GPC ID Google |
| `item_group_id` | warunkowy | **null dla ceramiki** (unikaty); **wspólny dla printów** | patrz §6 |
| `size`/`color`/`material`/`pattern` | warianty | dla printów (rozmiar, ramka) | patrz §6 |

**Propozycja mapy `google_product_category`** (do potwierdzenia w fazie spec — patrz Open Questions):
- kubki → *Home & Garden > Kitchen & Dining > Tableware > Drinkware > Mugs*
- miski/michy/miski-falowane → *Home & Garden > Kitchen & Dining > Tableware > Dinnerware > Bowls* (GPC 4026)
- talerze (wszystkie) → *Home & Garden > Kitchen & Dining > Tableware > Dinnerware > Plates*
- wazony (wszystkie) → *Home & Garden > Decor > Vases* (GPC 696)
- printy fine-art → *Arts & Entertainment > Hobbies & Creative Arts > Artwork > Posters, Prints, & Visual Artwork* (GPC 5989)

### 2.3. Handmade bez GTIN — `identifier_exists`

- Dla produktów bez unikalnych identyfikatorów (GTIN/MPN/brand) ustaw **`identifier_exists = no`** (lub `false`). Google explicite wymienia *„custom goods or one-of-a-kind products, like custom T-shirts, art, or handmade goods"* jako kanoniczny przypadek. *(wysoka, 3-0)* — <https://support.google.com/merchants/answer/6324478>, <https://support.google.com/merchants/answer/160161>
- **Pułapka:** jeśli produkt JEDNAK ma jakikolwiek unikalny identyfikator, **nie** wysyłaj `identifier_exists=no` — grozi disapproval. *(wysoka)*
- **Nie wymyślać GTIN ani nie kopiować z podobnych produktów** — twardy disapproval. Zamiast tego: `brand="Anna Ciok"` + opcjonalnie `mpn=<wewn. id>`.

### 2.4. `availability` — dozwolone wartości

- Tylko: **`in_stock`, `out_of_stock`, `preorder`, `backorder`** (standardowy feed online). *(wysoka, 3-0)*
- `limited_availability`/`on_display_to_order` → tylko local inventory ads; `build_to_order` → tylko pojazdy. **Nie używać tutaj.**
- **Musi zgadzać się z dostępnością na landing page i w structured data** (np. `in_stock`/`out_of_stock` w schema.org). *(wysoka)* — repo już renderuje `availabilityFor()` w [`structured-data.ts`](../../src/lib/seo/structured-data.ts), ale mapuje na `schema.org/InStock|SoldOut` — patrz §12 o spójności.

---

## 3. Meta (Facebook/Instagram) Catalog — specyfikacja + różnice vs Google

> Pewność: cytaty do Meta for Developers / Business Help; część pól potwierdzona głównie przez wtórne przewodniki feedowe agregujące oficjalną specyfikację (oznaczone).

### 3.1. Pola katalogu Meta

**Wymagane (wszystkie typy produktów):** `id` (≤100), `title` (≤200), `description` (plain text, ≤9999), `availability`, `condition`, `price`, `link`, `image_link` (min 500×500, zalecane 1024×1024), `brand` (wymagany US, **silnie zalecany EU**).

**Kluczowe różnice enumów vs Google:**

| Pole | Google | **Meta** |
|---|---|---|
| `availability` | `in_stock`, `out_of_stock` (podkreślnik) | **`in stock`, `out of stock` (SPACJA!)** + `available for order`, `preorder`, `discontinued` |
| `condition` | `new`/`refurbished`/`used` | `new`/`refurbished`/`used` (zgodne) |
| `price` | `"95.00 PLN"` | `"95.00 PLN"` (ten sam format `{value} {ISO4217}`, jedna spacja) |

> ⚠️ **Najczęstszy błąd przy współdzieleniu kodu generującego:** Google chce `out_of_stock`, Meta chce `out of stock`. Generator musi mieć osobne mapowanie enuma per platforma.

**Zalecane/opcjonalne:** `google_product_category` (Meta preferuje GPC nad `fb_product_category`), `additional_image_link` (do 20), `sale_price`, `sale_price_effective_date`, `item_group_id`, `color`/`size`/`material`/`pattern`, `gtin`/`mpn` (silnie egzekwowane w EU), `product_type`.

Źródła: <https://www.facebook.com/business/help/120325381656392>, <https://developers.facebook.com/docs/commerce-platform/catalog/fields/>, <https://developers.facebook.com/docs/commerce-platform/catalog/variants>.

### 3.2. Metody ingestu danych do Meta

1. **Hostowany feed (CSV/TSV/XML/XLSX/Google Sheets)** — `Commerce Manager > Catalog > Data Sources > Add Data Feed`. Max 100 MB / 1 mln pozycji, pobierany na harmonogramie (min. godzinowo). Najprostszy dla wolnozmiennego katalogu.
2. **Catalog Batch API** — `POST https://graph.facebook.com/v{N}/{catalog_id}/items_batch` z `item_type: "PRODUCT_ITEM"` i tablicą `requests` (`method: CREATE|UPDATE|DELETE`). **UPDATE jest upsertem.** Przetwarzanie **asynchroniczne** — API zwraca 200 nawet przy częściowych błędach; błędy trzeba odpytać osobno.
3. **Commerce/Catalog API direct** — pojedyncze pozycje.
4. **Pixel/dataset auto-population** — odpada (za mała kontrola nad metadanymi bespoke).

**Rate limit:** ~100 wywołań/h per katalog (snippet z oficjalnych docs). Dla unikatów (1 sztuka = 1 sprzedaż = 1 wywołanie) — z ogromnym zapasem.
**Max batch size:** podawane jako 5000 pozycji/request, ale **NIE potwierdzone w źródle pierwotnym** — zweryfikować przed implementacją.

Źródła: <https://developers.facebook.com/docs/marketing-api/catalog-batch/reference>, <https://developers.facebook.com/docs/marketing-api/catalog-batch/guides/send-item-updates/>.

### 3.3. Warianty Meta

Struktura **identyczna jak Google**: każdy wariant = osobna pozycja z własnym `id`, spięte wspólnym **`item_group_id`** (ta sama nazwa pola). Osie wariantów: `color`, `size`, `material`, `pattern`, `gender`, `age_group`. **Brak dedykowanego pola „frame"** → dla printów użyj `material` (lub `pattern`) jako osi „Framed/Unframed" — konsekwentnie. (Patrz §6.)

### 3.4. Pixel/CAPI ↔ katalog (dynamic/Advantage+ catalog ads)

- `content_ids` w eventach Pixel/CAPI **muszą dokładnie pasować** do `id` pozycji katalogu — inaczej brak atrybucji i retargetingu. *(potwierdzone w docs)*
- `content_type: "product"` (konkretny wariant) vs `"product_group"` (gdy wariant nie wybrany, np. lista) → użyj `item_group_id`.
- Repo już ma deduplikację `purchase-<payment_intent_id>` (patrz [`docs/analytics-stack.md`](../analytics-stack.md)) — wzorzec poprawny; trzeba tylko zapewnić że CAPI `content_ids` = `product.id` z katalogu.

### 3.5. Meta Shops a Polska — ważne ograniczenie

- **Polska NIE kwalifikuje się do Meta Shops z natywnym checkoutem** (od 10 sierpnia 2023 Shops z checkoutem ograniczone do wybranych krajów EEMA; PL wykluczona). Dla PL działają: **Katalog (feed), Advantage+/Dynamic Product Ads (klik → checkout na stronie), product tags, discovery na IG** — checkout zawsze na własnej stronie. *(wtórne, ale spójne)*
- **Wniosek:** dla tego sklepu Meta = **reklamy katalogowe kierujące na własny checkout** (co już mamy), nie natywny sklep na FB/IG.

---

## 4. Multi-language + multi-currency

### 4.1. Google

- **Ten sam `id` we wszystkich krajach/językach**; różnicują `contentLanguage` + `feedLabel`. *(wysoka)*
- **Cena VAT-inclusive dla wszystkich krajów poza US/Kanadą** → ceny PL/EU/**UK** brutto. *(wysoka, 3-0)*
- Jedno konto MC może targetować PL (PLN) + kraje EU (EUR) + **UK (GBP)** jednocześnie. Różny język ⇒ osobne data source per grupa językowa. *(wysoka)*
- Cena musi zawierać kod ISO 4217 (`95.00 PLN`, `25.00 EUR`, `21.00 GBP`); sam symbol odrzucany.
- Źródła: <https://support.google.com/merchants/answer/14991840>, <https://support.google.com/merchants/answer/7052209>, <https://support.google.com/merchants/answer/6324371>.

**Dwa wymiary, nie jeden (po rozstrzygnięciu „EU + UK"):**
- **Język (`contentLanguage`):** `pl`, `en`, `es` — sterują `title`/`description`.
- **Kraj/waluta (`feedLabel` + target country):** `PL→PLN`, `EU→EUR`, `UK→GBP`.

Realne kombinacje do wygenerowania (jeden `offerId` = `product.id`, wiele `ProductInput`):

| `feedLabel` | Język(i) | Waluta | Kraje targetu |
|---|---|---|---|
| `PL` | `pl` | PLN | Polska |
| `EU` | `en`, `es` | EUR | strefa UE (do zawężenia w spec — np. wszystkie EU/EEA) |
| `UK` | `en` | GBP | Wielka Brytania |

**Mapowanie na repo:** `priceOf(product, locale)` zwraca dziś tylko PLN/EUR — **trzeba dołożyć GBP** (`PRICE_GBP` brutto + rozszerzyć sygnaturę o kraj/walutę, nie tylko locale, bo `en` występuje i w EUR i w GBP). UK to osobny target regulacyjny (post-Brexit) — patrz §11.

### 4.2. Meta

- Model: **jeden primary katalog + override feedy** (nie wiele katalogów):
  - **Country feed** (override `price`, `sale_price`, `availability`, `link`) — wartość override = kod kraju (`PL`, `DE`, `ES`).
  - **Language feed** (override `title`, `description`) — format `lang_COUNTRY` (`pl_PL`, `en_US`, `es_ES`).
- Nie da się łączyć języka i ceny w jednym override feedzie; **brak udokumentowanej drogi push override'ów lokalowych przez `items_batch`** — lokalizacja jest plikowa, a realtime `availability` na primary feedzie propaguje się do wszystkich lokali.
- Źródła (wtórne, spójne): override feed guides AdTribes/Scandiweb/Feedoptimise.

**Wniosek dla repo:** primary feed = polski/PLN (default locale `/`); en/es jako language override feedy; kraje EUR jako country override feedy. Realtime sold-out → `items_batch UPDATE availability` na primary.

---

## 5. Unikatowy inventory — realtime sold-out

### 5.1. Wzorzec push z webhooka Stripe — TAK, ale z zastrzeżeniem

- Push `availability=out_of_stock` z webhooka Stripe gdy sprzeda się unikat to **poprawny, udokumentowany wzorzec** (Google explicite zaleca API do natychmiastowej aktualizacji, by feed i strona były spójne przy starcie/końcu sprzedaży). *(wysoka)*
- **ALE: to nie jest natychmiastowe.** Między wysłaniem update'u a odzwierciedleniem w `Product` jest **opóźnienie, zwykle kilka minut** (wieloetapowe przetwarzanie). *(wysoka, 3-0)* — <https://developers.google.com/merchant/api/guides/products/frequent-updates>
- ⚠️ **Twierdzenie „partial patch price/availability = near-realtime" zostało ODRZUCONE (głos 0-3).** Metoda `patch` istnieje, ale dokładna semantyka partial-update i „realtime" wymaga weryfikacji na żywej dokumentacji — **nie obiecuj natychmiastowego znikania z reklam.**

### 5.2. Batching i quota (Google)

- **Batch jest liczony per operacja, bez zniżki** — 500 insertów w batchu = 500 wywołań względem quoty. Batchuj dla efektywności HTTP, nie dla oszczędności quoty. *(wysoka, 3-0)* — <https://developers.google.com/merchant/api/guides/quotas-limits>

### 5.3. Meta — analogicznie

- Na `payment_intent.succeeded` → po `markPaid` → `POST /{catalog_id}/items_batch` z jednym `UPDATE availability: "out of stock"`. Async, 200 nawet przy błędach (odpytać błędy osobno). Rate 100/h — z zapasem.

### 5.4. Integracja z istniejącym webhookiem

Repo ma już idealny punkt zaczepienia — [`src/lib/webhook.ts`](../../src/lib/webhook.ts) `handleStripeEvent()`:
- `payment_intent.succeeded` → `markPaid` (idempotentny, zwraca `newlySold`) → **tu dodać push `out_of_stock` do Google + Meta** (best-effort, jak `trackPurchase`).
- `payment_intent.payment_failed`/`canceled` → `releaseHold` → **push `in_stock`** (przedmiot wraca).
- `charge.refunded` (pełny) / `charge.dispute.closed` (lost) → `releaseSale` (relisting) → **push `in_stock`**.

Wzorzec: nowa zależność w `WebhookDeps` (np. `syncCatalog(productId, availability)`), best-effort z logowaniem (nie wywracać webhooka gdy Google/Meta padnie). **Uwaga:** push z webhooka działa tylko jeśli kod Workers ma sekrety i potrafi zrobić JWT — patrz §7–8.

### 5.5. Permanentnie sprzedane unikaty — usuwać z feedu

- Google: **nie trzymaj `out_of_stock` w nieskończoność dla rzeczy których już nie sprzedajesz** — usuń produkt z danych. <https://support.google.com/merchants/answer/6337960>
- **Rekomendowany wzorzec dla unikatów (one-of-a-kind):**
  1. Na sprzedaż → natychmiast `out_of_stock` (zatrzymuje wydatki reklamowe).
  2. Po pewnym czasie (job/cron) → **`delete` ProductInput** w Google i **`DELETE` w Meta** (permanentnie sprzedane).
  3. **Stronę PDP trzymaj żywą** z `SoldOut` w JSON-LD i oznaczeniem „sprzedane" (SEO + linki) — to jest OK dla GMC, bo po usunięciu z feedu Google przestaje crawlować ten URL (brak 404-disapproval).
- To rozdziela „znika z feedu/reklam" od „znika ze strony" — patrz §12 (różnica: przedmioty USUNIĘTE z `products.ts` → realny 404; SPRZEDANE → strona żyje z SoldOut).

---

## 6. Warianty (printy fine-art: rozmiar × papier × oprawa) — REPRODUKOWALNE

> **Model docelowy (rozstrzygnięty):** print to produkt **reprodukowalny** (stock > 1, np. 10 szt/wariant), nie unikat. Użytkownik zamawia *„Print A w jednym z 4 rozmiarów, na jednym z 2 papierów, oprawiony lub nie"* → **3 osie wariantów: rozmiar (4) × papier (2) × oprawa (2) = do 16 wariantów** w jednej grupie. Ta sama kategoria, **cena per wariant**, **stan ilościowy per wariant**.

### 6.1. Mapowanie 3 osi na atrybuty wariantów (Google + Meta)

Oba systemy: **wspólny `item_group_id`** dla całej grupy, unikalny `id` per wariant, osie jako atrybuty wariantów. Google ma „miękkie" osie wariantów: `size`, `material`, `pattern`, `color`. Wykorzystujemy trzy z nich:

| Oś produktu | Atrybut Google/Meta | Przykładowe wartości |
|---|---|---|
| Rozmiar | **`size`** | `21×30 cm` (A4), `30×40 cm`, `50×70 cm`, `70×100 cm` |
| Papier | **`material`** | `Hahnemühle Photo Rag`, `mat 250 g` (rzeczywiste nazwy papierów) |
| Oprawa | **`pattern`** | `W ramie` / `Bez ramy` |

`item_group_id` wymagany dla free listings dla wszystkich wariantów. *(wysoka, 3-0)* — <https://support.google.com/merchants/answer/6324507>. Meta: identyczne pola (`item_group_id`, `size`, `material`, `pattern`).

> **Alternatywa do rozważenia w spec:** oprawa drastycznie zmienia wymiary/wagę/wysyłkę, więc niektórzy rozbijają „W ramie" vs „Bez ramy" na **osobne `item_group_id`** zamiast osi `pattern`. Rekomendacja: zacznij od jednej grupy z 3 osiami (prostsze), rozbij dopiero gdy logistyka oprawy tego wymaga.

**Przykład grupy:**
```
item_group_id: "print-anna-01"
  id="print-anna-01-30x40-rag-frame"   size="30×40 cm" material="Photo Rag" pattern="W ramie"   price="..." availability="in_stock"
  id="print-anna-01-30x40-rag-noframe" size="30×40 cm" material="Photo Rag" pattern="Bez ramy"  price="..." availability="in_stock"
  id="print-anna-01-30x40-mat-frame"   size="30×40 cm" material="mat 250 g" pattern="W ramie"   ...
  ... (do 16 kombinacji)
```
**Uwaga konsystencji:** jeśli którykolwiek wariant w grupie ma daną oś, **wszystkie** muszą ją mieć (Google odrzuca niespójne grupy).

### 6.2. Model danych w repo — największa praca fazy spec

Obecny [`products.ts`](../../src/lib/products.ts) (`Product` = 1 szt, `price` skalar, `sold` boolean) i `piece_state` (PK `product_id`, status unikatowy `available|reserved|sold`) **nie modelują wariantów ani ilości.** Printy wymagają:

- **Nowy rejestr printów** (osobny od ceramiki, bo inny kształt): `print` → `{ id, category, image/gallery, item_group_id, variants[] }`, gdzie `variant = { sku, size, paper, frame, price: {pln,eur,gbp}, ... }`.
- **Nowa tabela stanu ilościowego**, np. `print_variant_state(sku PK, stock int, reserved int, ...)` — **odrębna od `piece_state`** (tamta zakłada unikat). Albo uogólnienie `piece_state` o kolumnę `quantity` (ryzykowne dla istniejących inwariantów ceramiki — patrz [[shop-status-filter]], `resolveCartProducts` filtruje `sold`).
- **Rezerwacja/checkout:** dziś `reserve_pieces()` RPC zakłada lock jednej sztuki na 15 min. Printy potrzebują dekrementu ilości (`stock - qty >= 0`) — inny RPC/ścieżka. Stripe i checkout muszą rozróżnić „unikat" vs „wariant z ilością".
- **Koszyk:** `acc_cart_v1` to dziś `Set<id>` bez ilości. Print-wariant jako SKU mieści się w secie (1 szt każdego), ale **zamówienie >1 szt tego samego wariantu wymaga ilości w koszyku** — decyzja produktowa (patrz Open Questions). Rekomendacja MVP: koszyk pozostaje setem SKU (max 1 szt/wariant na zamówienie) — najmniejsza zmiana; ilości dołożyć później jeśli potrzebne.

### 6.3. Dostępność wariantu w feedzie

- print-wariant → `in_stock` gdy `stock > 0`, inaczej `out_of_stock` (analogicznie `in stock`/`out of stock` w Meta).
- Sprzedaż printu **dekrementuje `stock`** (nie ustawia `sold`); push do feedu tylko gdy `stock` przekroczy 0→1 lub 1→0 (zmiana `availability`), nie przy każdej sprzedaży.
- Grupa (`item_group_id`) żyje w feedzie póki **co najmniej jeden** wariant ma `stock>0`; `delete` grupy dopiero gdy cała wyprzedana (patrz §0.5 #7).

---

## 7. Uwierzytelnianie i dostęp do API

### 7.1. Google Merchant API

- **Service account vs OAuth:** dla server-to-server (nasz przypadek) — **service account** (konto serwisowe GCP z kluczem JSON), nadane jako użytkownik w Merchant Center. Alternatywa OAuth refresh-token (do działań „w imieniu użytkownika").
- Flow auth na Workers: service-account JSON → **JWT (RS256) podpisany WebCrypto** → wymiana na access token w `https://oauth2.googleapis.com/token` → Bearer w REST. (Patrz §8 — to jest sedno kompatybilności z Workers.)
- Scope: `https://www.googleapis.com/auth/content`.

### 7.2. Google Ads API (tylko jeśli automatyzujemy kampanie — patrz §10)

- **Developer token** (22 znaki) — **tylko z konta Manager (MCC)**, wysyłany w nagłówku `developer-token`. Poziomy: Test → Basic (15k ops/dzień, review ~5 dni) → Standard. *(wysoka)*
- **Service accounts SĄ wspierane** (klucz JSON, do 20 kont Ads), **ale domain-wide delegation NIE jest wspierane.** Administratorski dostęp service accountowi trzeba nadać ręcznie w UI. *(wysoka)* — <https://developers.google.com/google-ads/api/docs/oauth/service-accounts>
- Nagłówki: `Authorization: Bearer`, `developer-token`, `login-customer-id` (= MCC, bez myślników, gdy idziesz przez MCC).
- Minimum dla małego reklamodawcy: MCC → developer token (Basic) → GCP project + credentials → sklep jako client account pod MCC.

### 7.3. Meta

- **Business Manager** → **System User** (rola **Admin** dla `catalog_management`) → instalacja app na system userze → generacja tokenu z scope **`catalog_management`, `business_management`, `ads_management`**.
- ⚠️ **Tokeny niewygasające:** dokumentacja Meta sygnalizuje przejście na tokeny wygasające (60 dni) — **zweryfikować czy permanentny token jest jeszcze dostępny** przy konfiguracji. Założyć w spec mechanizm odświeżania na wszelki wypadek.
- Źródła: <https://developers.facebook.com/docs/business-management-apis/system-users/>, <https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/>.

### 7.4. Sekrety na Cloudflare Workers

- Wszystkie tokeny/klucze = **runtime secrets** (`wrangler secret put` w prod, `.dev.vars` lokalnie) — tak jak istniejące `STRIPE_SECRET_KEY` (patrz `AGENTS.md` → Environment Variables).
- Proponowane nazwy sekretów (do spec): `GOOGLE_SA_JSON` (cały JSON konta serwisowego), `GOOGLE_MERCHANT_ACCOUNT_ID`, `META_CATALOG_ID`, `META_CATALOG_ACCESS_TOKEN`, (+ later: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CUSTOMER_ID`).
- ⚠️ JSON konta serwisowego jest duży — sprawdzić limit rozmiaru sekretu Workers, ewentualnie rozbić na `client_email` + `private_key`.

---

## 8. Biblioteki / SDK — co działa na Workers runtime

> Realny bloker na Workers: **gRPC** (`google-ads-api`, oficjalny klient Ads) i moduły Node-only których SDK używa zbędnie. **Podpis JWT NIE jest już blokerem** — patrz korekta niżej.

**✅ KOREKTA względem pierwotnego researchu (zweryfikowana na żywej dokumentacji CF, 2026-06-12):** pełne **`node:crypto` (w tym `sign`/`verify`, RSA) i `node:tls` są dostępne na Workers z `nodejs_compat` od 2025-04-08** (<https://developers.cloudflare.com/changelog/post/2025-04-08-nodejs-crypto-and-tls/>). Repo **już** ma `nodejs_compat` + `compatibility_date: 2026-06-02` (`wrangler.jsonc`), więc podpis service-account JWT można zrobić natywnie — `node:crypto.sign('RSA-SHA256', …)` **albo** WebCrypto `crypto.subtle` (CF Best Practices, 2026-02-15, zalecają Web Crypto do generowania tokenów). Wcześniejsza teza „Node crypto signing path nie działa na Workers" jest **nieaktualna**.

| Biblioteka | Runtime Workers? | Werdykt |
|---|---|---|
| `crypto.subtle` (WebCrypto) / `node:crypto` `sign()` | ✅ tak | **Użyj do podpisu SA JWT (RS256).** WebCrypto rekomendowane przez CF; `node:crypto` też działa. Własny ~30-liniowy helper > zewn. pakiet. |
| `@sagi.io/workers-jwt` (`getTokenFromGCPServiceAccount`) | ✅ tak (WebCrypto) | działa, ale niszowy/mało utrzymywany → **preferuj własny helper.** |
| `googleapis` (pełne Node SDK) | ⚠️ niepotrzebne | Dla samego Merchant REST zbędne; ryzyko http2. **REST, nie SDK.** |
| `@google-shopping/*` (nowe klienty Merchant API) | ⚠️ niezweryfikowane na Workers | preferuj REST (decyzja: REST-only). |
| `google-ads-api` (Opteo) / oficjalny `google-ads-nodejs-client` | ❌ **nie** | oba na **gRPC** → nie działają na Workers. **Google Ads API ma pełne REST** (`googleads.googleapis.com/v{N}/`) — wołaj `fetch`em. *(wysoka)* |
| `facebook-nodejs-business-sdk` | ❌ unikać | zależy od `node:http(s)`; to i tak tylko JSON-over-HTTPS — **rób `fetch`em.** |

**Konkluzja:** **REST-first, fetch-only**, podpis JWT przez WebCrypto/`node:crypto`. Zero ciężkich SDK. Spójne z resztą repo (Stripe/Supabase/InPost też przez API). Decyzja z §0.5 #8 zablokowana: **nie testujemy bundlowania `googleapis`.**

---

## 9. Operacyjny model wdrożenia w repo

### 9.1. Gdzie generować dane produktowe

Jeden **wspólny builder** mapujący `getProducts()` + `getSoldIds()` + i18n (`messages/*`) + `priceOf()` na neutralny model „catalog item per locale", a potem **adaptery per platforma** (Google ProductInput / Meta item / XML row) z osobnym mapowaniem enumów (`out_of_stock` vs `out of stock`).

### 9.2. Trzy ścieżki danych

| Ścieżka | Mechanizm w repo | Cel |
|---|---|---|
| **Hostowany feed** | route handler `GET /api/feed/google.xml`, `GET /api/feed/facebook.xml` (App Router, dynamic) | bootstrap, Meta scheduled feed, fallback, DR |
| **Realtime push (delta)** | rozszerzenie `WebhookDeps.syncCatalog()` w [`webhook.ts`](../../src/lib/webhook.ts) na zdarzeniach Stripe | natychmiastowe `out_of_stock`/`in_stock` |
| **Pełny re-sync (reconcile)** | cron w [`worker.ts`](../../worker.ts) (już jest cron co 15 min do wygasania zamówień) | okresowe wyrównanie katalogu z `piece_state`, sprzątanie permanentnie sprzedanych (`delete`) |

### 9.3. Rate limity / batching

- Google: batch per-operacja względem quoty (bez zniżki) → batchuj re-sync, ale delty rób pojedynczo.
- Meta: 100/h per katalog → z zapasem dla unikatów.
- Best-effort + retry/log; **nie blokować webhooka Stripe** gdy katalog API padnie (Stripe i tak ma swoje retry, ale sync katalogu nie powinien wymuszać 500 na webhooku — patrz wzorzec `trackPurchase`/`ensureInvoiced` z połykaniem błędów).

### 9.4. Cache/spójność z istniejącym `revalidateTag('inventory')`

Webhook już woła `revalidate('inventory')` (busting cache Next dla galerii). Sync katalogu Google/Meta dokłada się obok — ten sam moment (`newlySold`), ten sam `productId`.

---

## 10. Google Ads: katalog vs kampanie

- **Katalog = Merchant Center; kampanie = Google Ads.** Do wrzucenia produktów do Merchant Center **Google Ads API NIE jest potrzebne.** Google Ads API jest potrzebne dopiero do tworzenia/zarządzania kampaniami (Performance Max, Shopping), budżetami, listing/asset groups. *(wysoka)* — <https://developers.google.com/google-ads/api/docs/shopping-ads/overview>
- **Linkowanie Ads ↔ Merchant Center:**
  - UI: z MC `Settings → Apps and services → Add service → Google Ads customer ID`; z Ads `Tools → Data manager → Connected products`. Własne konto = link natychmiastowy; cudze = wymaga akceptacji.
  - API (2026): Merchant API `accounts.services.propose/approve/reject` (zastąpiło stare `accounts.link`); po stronie Ads `ProductLinkService`/`ProductLinkInvitationService` (stare `MerchantCenterLinkService` wycofane). <https://support.google.com/merchants/answer/12499498>, <https://developers.google.com/google-ads/api/docs/shopping-ads/merchant-center>
- **Performance Max (retail):** `Campaign.shopping_setting.merchant_id` (+ opcj. `feed_label`) → asset groups → listing group tree (`AssetGroupListingGroupFilter`). Da się w pełni przez API. <https://developers.google.com/google-ads/api/performance-max/retail>
- **Shopping vs PMax w 2026:** standardowy Shopping **NIE jest deprecjonowany**; oba wspierane, o serwowanie konkuruje Ad Rank. Dla małego sklepu standardowy Shopping = prostsza kontrola; PMax = AI po wszystkich powierzchniach. <https://support.google.com/google-ads/answer/2454022>
- **Conversion tracking:** najszybsza ścieżka — link GA4↔Ads, oznacz `purchase` jako key event, importuj do Ads jako konwersję; Enhanced Conversions skonfiguruj w GA4 (hashowane `user_data`), spłynie do Ads. Repo ma już GA4 + server-side MP + Consent Mode v2 + wzorzec hashowania PII (Meta CAPI) — strukturalnie gotowe. (Uwaga: konwersje importowane z GA4 nie są bezpośrednio „Enhanced Conversions" w Ads, ale EC z GA4 spływa automatycznie.) <https://support.google.com/google-ads/answer/2375435>

**Wniosek dla fazy 1:** katalog (Google MC + Meta) **bez** Google Ads API. Google Ads API to osobna, późniejsza faza (automatyzacja kampanii) — albo w ogóle ręcznie w UI + import konwersji z GA4.

---

## 11. Realia EU / Polska / UK

> **Uwaga UK (post-Brexit, po rozstrzygnięciu „EU + UK"):** Wielka Brytania to **osobny target regulacyjny i walutowy (GBP)**. Cena nadal **VAT-inclusive** (UK nie jest US/Kanadą). UK ma własne wymogi (UK VAT, brak unijnego CSS — CSS dotyczy EEA, nie UK), własny `feedLabel`/target country. Konsekwencje konsumenckie (prawo odstąpienia) reguluje UK Consumer Contracts Regulations (analogiczne 14 dni), nie unijna dyrektywa. Do doprecyzowania w spec: rejestracja UK VAT / próg, koszty/logistyka wysyłki do UK. Poniższe punkty EU dotyczą Polski + strefy EUR; UK traktować jako równoległy, lekko odmienny zestaw wymogów.

- **Polityka zwrotów: WYMAGANA.** Jasna informacja o zwrotach/refundach dostępna bez logowania; account-level default + opcjonalnie product-level (`return_policy_label`). Brak/odrzucona polityka → disapprovale. EU: min. **14 dni** prawa odstąpienia (Dyrektywa 2011/83/EU; krótsze okno = twardy disapproval). Handmade „na zamówienie/spersonalizowane" może być wyłączone z prawa odstąpienia, ale standardowa ceramika nie. <https://support.google.com/merchants/answer/14011730>, <https://support.google.com/merchants/answer/9445425>
  - **Repo ma już** strony [`/dostawa-i-zwroty`](../../src/app/[locale]/dostawa-i-zwroty/page.tsx), [`/zwrot`](../../src/app/[locale]/zwrot/page.tsx), [`/regulamin`](../../src/app/[locale]/regulamin/page.tsx), [`/polityka-prywatnosci`](../../src/app/[locale]/polityka-prywatnosci/page.tsx), [`/kontakt`](../../src/app/[locale]/kontakt/page.tsx) — do audytu pod kątem treści wymaganej przez MC.
- **Weryfikacja tożsamości (rozszerzona 01/2025):** obowiązkowa weryfikacja tożsamości dla wszystkich merchantów w EU/UK/US/CA/AU (dokument tożsamości, dowód adresu, rejestracja firmy; 30 dni na dopełnienie). *(wtórne, cross-confirmed)*
- **CSS w EEA:** każde konto MC używane do Shopping ads w EEA (w tym PL) **musi być powiązane z Comparison Shopping Service**; nowe konta domyślnie = „Google Shopping" jako CSS (spełnia wymóg out-of-the-box). <https://support.google.com/merchants/answer/12653197>
- **Wymagane strony:** zwroty/refund, prywatność, dostawa (shipping), regulamin (ToS), kontakt (min. jedna forma), HTTPS, adres firmy w ustawieniach MC. Strony nie mogą być generyczne/placeholder. <https://support.google.com/merchants/answer/12756116>
- **Weryfikacja domeny:** meta tag/plik HTML/GTM/GA4/email → potem „Claim website". Jeśli GA4 już podpięte, może zadziałać automatycznie. <https://support.google.com/merchants/answer/11586344>
- **Ceny VAT-inclusive** dla EU; **update polityki cenowej z września 2025** (potwierdzony): opłaty merchanta (service/handling) w `shipping`, nie w cenie; opłaty rządowe NIE doliczane; spójność cena↔landing page↔structured data. <https://support.google.com/merchants/answer/7052209>, <https://www.seroundtable.com/google-merchant-center-pricing-policies-updated-40094.html>
- **Consent Mode v2** obowiązkowy w EEA od 6 marca 2024 dla Ads/GA-do-Ads (4 sygnały: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`). **Free listings nie wymagają Consent Mode** (umiarkowana pewność), ale i tak warto dla jakości GA4. Advanced Consent Mode → modelowanie konwersji dla niewyrażających zgody. Repo ma już Consent Mode v2 default-deny przez GTM. <https://support.google.com/google-ads/answer/13695607>
- **Enhanced Conversions** wysyła hashowane PII tylko gdy `ad_user_data` granted; komplementarne do Consent Mode v2. Czerwiec 2026: EC for web + for leads zunifikowane; offline/EC-leads uploads przeniesione do **Data Manager API** od 15.06.2026. <https://support.google.com/google-ads/answer/16884284>

---

## 12. Pułapki / częste disapprovale

1. **Price mismatch / structured data.** Cena w feedzie MUSI = cena na landing page = `offers.price` w JSON-LD. Najczęstsza przyczyna: niezsynchronizowane update'y przy starcie/końcu sprzedaży; ceny wstrzykiwane client-side mogą wywołać błąd nawet gdy wizualnie OK → **server-rendered JSON-LD ma znaczenie.** *(wysoka)* — <https://support.google.com/merchants/answer/9773429>
   - ✅ Repo renderuje JSON-LD serwerowo ([`structured-data.ts`](../../src/lib/seo/structured-data.ts) `productSchema()`), z ceną z `priceOf` i walutą per locale — **zgodnie z wymogiem.**
   - ⚠️ **Spójność `availability`:** structured-data używa `schema.org/InStock|SoldOut`, feed używa `in_stock|out_of_stock`. To **różne przestrzenie wartości tej samej informacji** — generator feedu i JSON-LD muszą czerpać z tego samego źródła (`getSoldIds()`), inaczej grozi mismatch.
2. **Image requirements.** Min. rozmiary, brak watermarków/tekstu promo, WebP akceptowany. Repo: WebP w `public/uploads/`, natywny `<img>` (nie `next/image`) — to **nie jest problem dla feedu** (feed używa bezpośredniego URL obrazu, nie renderera Next). Upewnić się że URL-e obrazów są publicznie crawlowalne.
3. **Landing page crawlability.** Strona musi zwracać 200 dla crawlera. Natywny `<img>` zamiast `next/image` jest **neutralny/pozytywny** dla crawlowalności (brak zależności od optymalizatora). Treść (cena, dostępność) musi być w HTML server-side.
4. **404 po sprzedaży — rozróżnić dwa przypadki:**
   - **Przedmioty USUNIĘTE z katalogu** (`REMOVED` w `products.ts`, np. `k15`, `x01`) → ich URL-e dają realny 404 (PDP `notFound()` → HTTP 404, brak `loading.tsx` w `(pdp)`). **Te ID nie mogą być w feedzie** — inaczej disapproval „landing page not found".
   - **Przedmioty SPRZEDANE** (`sold`/`piece_state.status='sold'`) → strona PDP **żyje** z `SoldOut` w JSON-LD. To OK dla SEO; dla feedu: najpierw `out_of_stock`, potem `delete` z feedu (patrz §5.5). Google nie karze 404 za pozycję już usuniętą z feedu (przestaje crawlować).
   - <https://support.google.com/merchants/answer/12158123>, <https://support.google.com/merchants/answer/6337960>
5. **Handmade GTIN trap** (patrz §2.3): `identifier_exists=no`, nigdy fałszywy GTIN.
6. **Meta enum trap:** `out of stock` (spacja) vs Google `out_of_stock` — osobne mapowanie.

---

## Mapowanie end-to-end (skrót dla fazy spec)

```
products.ts getProducts()  ──┐
pricing.ts priceOf()         │   buildCatalogItems(locale, country)
messages/{locale}.json       ├──►  → neutral CatalogItem[]
inventory.ts getSoldIds()    │         (id, title, desc, link, image[],
SITE_URL / absoluteUrl()   ──┘          price+ccy, availability, brand,
                                        identifierExists, gpc, productType,
                                        itemGroupId?, variantAxes?)
                                              │
            ┌─────────────────────────────────┼─────────────────────────────────┐
            ▼                                 ▼                                 ▼
   Google adapter                     Meta adapter                      XML adapter
   ProductInput (REST insert/         items_batch CREATE/UPDATE         RSS 2.0 rows
   patch/delete, API data source)     (availability "in stock")        (/api/feed/*.xml)
   availability in_stock              graph.facebook.com               hostowany feed
   merchantapi.googleapis.com         /{catalog_id}/items_batch        (Meta scheduled,
   auth: SA JWT (WebCrypto)           auth: System User token          bootstrap, DR)
            │                                 │
            └──────────── push delta on Stripe webhook (webhook.ts syncCatalog) ───────────┘
                          + cron reconcile in worker.ts (full re-sync + delete sold)
```

---

## Open Questions

**Większość rozstrzygnięta — patrz §0.5.** Poniżej tylko to, co realnie zostało do decyzji w fazie spec/implementacji:

### Wymagają decyzji produktowej / biznesowej
1. **Zakres krajów EUR** — cała UE/EEA czy wybrane kraje? (determinuje target countries dla `feedLabel: EU`).
2. **UK VAT / logistyka** — rejestracja UK VAT (próg ~£90k), realne koszty i sposób wysyłki do UK, ewentualne ograniczenie oprawy do PL/EU. (Może wpłynąć na to, które warianty printów oferować na UK.)
3. **Ilości w koszyku dla printów** — czy klient może kupić >1 szt tego samego wariantu? MVP: nie (koszyk = `Set<SKU>`). Jeśli tak → rozszerzenie modelu koszyka o ilości.
4. **Rzeczywiste osie printów** — finalne listy: 4 rozmiary (wymiary cm), 2 papiery (nazwy), ceny per wariant per waluta. Potrzebne do zbudowania rejestru.
5. **GBP cennik** — `PRICE_GBP` brutto per kategoria (ceramika) + per wariant (printy).

### Wymagają rozstrzygnięcia technicznego w spec
6. **Model danych printów** — osobny rejestr + `print_variant_state(sku, stock, reserved)` vs uogólnienie `piece_state` o `quantity`. Rekomendacja: **osobny**, by nie ruszać inwariantów unikatów ceramiki ([[shop-status-filter]]). Plus nowy RPC rezerwacji ilościowej (odpowiednik `reserve_pieces()` dla stocku).
7. **`priceOf()` → kraj/waluta** — refaktor sygnatury z `locale` na `(product, country|currency)`, bo `en` mapuje i na EUR (EU) i na GBP (UK).
8. **Finalne GPC ID** — potwierdzić w UI Merchant Center przy mapowaniu kategorii (propozycja §2.2 zaakceptowana).
9. **Audyt stron prawnych** — `/zwrot`, `/dostawa-i-zwroty`, `/regulamin`, `/polityka-prywatnosci`, `/kontakt` pod wymogi MC (§11) + przejście weryfikacji tożsamości + potwierdzenie CSS=Google Shopping. Osobny task.

### Do potwierdzenia przy implementacji (nie blokują spec)
10. **Max batch Meta** — przyjęto chunk 1000/request (§0.5 #13); zweryfikować w odpowiedzi `X-Business-Use-Case` jeśli kiedyś katalog urośnie.
11. **Rozmiar sekretu Workers** — potwierdzono limit 5 KB/sekret, SA JSON się mieści (§0.5 #6); zweryfikować realny rozmiar klucza przy wgrywaniu.

---

## Appendix A — pewność i twierdzenia odrzucone

**Zweryfikowane głosowaniem (deep-research harness, próg 2/3):** 19/25 twierdzeń potwierdzone. Rdzeń Google Merchant API (architektura, atrybuty, auth na Workers) = wysoka pewność.

**Twierdzenia ODRZUCONE / zakwestionowane w harnessie — część rozstrzygnięta późniejszą weryfikacją na żywej dokumentacji (2026-06-12, oznaczone ✅):**

| Odrzucone twierdzenie | Głos | Status / implikacja |
|---|---|---|
| „Partial patch price/availability = near-realtime updates" | 0-3 | **Aktualne:** `patch` istnieje, ale propagacja ~kilka minut; nie obiecuj realtime |
| „nodejs_compat wymaga compatibility_date ≥ 2024-09-23" | 0-3 | ✅ **Rozstrzygnięte:** repo ma `nodejs_compat`+`2026-06-02`; szczegół daty nieistotny |
| „Pełny `googleapis` Node SDK nie da się zbundlować na Workers" | 1-2 | ✅ **Bezprzedmiotowe:** decyzja REST-only (§0.5 #8) — nie bundlujemy SDK |
| „Workers natywnie wspierają pełny zbiór modułów Node" | 1-2 | ✅ **Rozstrzygnięte:** `node:crypto`+`node:tls` pełne od 2025-04-08 (CF changelog); gRPC nadal nie |
| „identifier_exists = wskaźnik braku GTIN/MPN/brand" (sformułowanie) | 1-0 (2 abstain) | sens OK; dokładne sformułowanie wg źródła |
| „Merchant API wspiera partial updates via patch (price/availability)" | 1-0 (2 abstain) | metoda istnieje; semantyka partial-update do weryfikacji na żywo |

**Dodatkowo zweryfikowane po researchu (2026-06-12, żywa dokumentacja):** limit sekretu Workers **5 KB** (CF docs/changelog); **`node:crypto` pełne API** (CF changelog 2025-04-08); repo `wrangler.jsonc` ma `nodejs_compat`+`compatibility_date: 2026-06-02`. Niepotwierdzone autorytatywnie: **max batch Meta `items_batch`** (5000 to liczba z przewodników wtórnych, nie ze źródła pierwotnego → przyjęto bezpieczny chunk 1000).

**Obszary uzupełnione przez agentów (cytaty do źródeł pierwotnych, BEZ głosowania adwersaryjnego — pewność „średnia-wysoka", zweryfikować krytyczne fakty):** całość Meta Catalog (§3), Google Ads linking/kampanie (§10), EU/PL compliance (§11). Część faktów Meta opiera się na wtórnych przewodnikach feedowych agregujących oficjalną specyfikację (oznaczone inline).

---

## Appendix B — źródła

**Google Merchant API (pierwotne):**
- <https://developers.google.com/merchant/api/latest-updates>
- <https://developers.google.com/merchant/api/guides/products/overview>
- <https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs>
- <https://developers.google.com/merchant/api/guides/products/add-manage>
- <https://developers.google.com/merchant/api/guides/data-sources/api-sources>
- <https://developers.google.com/merchant/api/guides/products/frequent-updates>
- <https://developers.google.com/merchant/api/guides/quotas-limits>
- <https://developers.google.com/merchant/api/guides/compatibility/account-linking>
- <https://developers.google.com/merchant/api/guides/compatibility/overview>

**Google Merchant Center (support / spec atrybutów + compliance):**
- <https://support.google.com/merchants/answer/7052112> (specyfikacja atrybutów)
- <https://support.google.com/merchants/answer/6324478> (identifier_exists)
- <https://support.google.com/merchants/answer/160161> (unique product identifiers)
- <https://support.google.com/merchants/answer/6324448> (availability)
- <https://support.google.com/merchants/answer/6324507> (item_group_id / warianty)
- <https://support.google.com/merchants/answer/9773429> (price mismatch / structured data)
- <https://support.google.com/merchants/answer/12158123> (product page unavailable / 404)
- <https://support.google.com/merchants/answer/6337960> (landing page maintenance / discontinued)
- <https://support.google.com/merchants/answer/14011730> (return policy)
- <https://support.google.com/merchants/answer/9445425> (return_policy_label)
- <https://support.google.com/merchants/answer/12756116> (guidelines / required pages)
- <https://support.google.com/merchants/answer/14286818> (business information)
- <https://support.google.com/merchants/answer/11586344> (URL verification)
- <https://support.google.com/merchants/answer/7052209> (tax/VAT)
- <https://support.google.com/merchants/answer/6324371> (price)
- <https://support.google.com/merchants/answer/14991840> (multiple target countries)
- <https://support.google.com/merchants/answer/10059987> (additional target countries)
- <https://support.google.com/merchants/answer/12653197> / <https://support.google.com/merchants/answer/12652686> (CSS)

**Google Ads API (pierwotne):**
- <https://developers.google.com/google-ads/api/docs/shopping-ads/overview>
- <https://developers.google.com/google-ads/api/docs/shopping-ads/merchant-center>
- <https://developers.google.com/google-ads/api/docs/api-policy/developer-token>
- <https://developers.google.com/google-ads/api/docs/api-policy/access-levels>
- <https://developers.google.com/google-ads/api/docs/concepts/call-structure>
- <https://developers.google.com/google-ads/api/docs/oauth/service-accounts>
- <https://developers.google.com/google-ads/api/rest/auth>
- <https://developers.google.com/google-ads/api/performance-max/retail>
- <https://developers.google.com/google-ads/api/docs/client-libs>
- <https://support.google.com/merchants/answer/12499498> (Ads↔MC linking UI)
- <https://support.google.com/google-ads/answer/2454022> (Shopping ads)
- <https://support.google.com/google-ads/answer/2375435> (import GA4 conversions)
- <https://support.google.com/google-ads/answer/13695607> (Consent Mode v2 EEA)
- <https://support.google.com/google-ads/answer/16884284> (Enhanced Conversions 2026)

**Meta / Facebook:**
- <https://www.facebook.com/business/help/120325381656392> (product data spec)
- <https://developers.facebook.com/docs/commerce-platform/catalog/fields/>
- <https://developers.facebook.com/docs/commerce-platform/catalog/variants>
- <https://developers.facebook.com/docs/marketing-api/catalog-batch/reference>
- <https://developers.facebook.com/docs/marketing-api/catalog-batch/guides/send-item-updates/>
- <https://developers.facebook.com/docs/business-management-apis/system-users/>
- <https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/>
- <https://developers.facebook.com/docs/meta-pixel/get-started/advantage-catalog-ads>

**Cloudflare Workers runtime / auth:**
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- <https://github.com/sagi/workers-jwt>
- <https://blog.cloudflare.com/nodejs-workers-2025/>

**Wtórne (feed/PPC, agregujące oficjalne specyfikacje):** Search Engine Land, Search Engine Journal, PPC Land, Store Growers, Marpipe, Productsup, FeedArmy, AdNabu, AdTribes, Scandiweb, Feedoptimise, Search Engine Roundtable (września 2025 pricing update), Glow­Metrics (Meta Shops EEMA).
