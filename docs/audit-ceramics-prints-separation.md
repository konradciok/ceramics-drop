# Audyt separacji produktów: ceramika vs printy fine art / Prodigi

> Data audytu: 2026-07-07. Stan repo: branch `main`, commit `2295686`.
> Zakres: model danych, PDP, koszyk, checkout, shipping, fulfilment, płatności, webhooks, InPost/ShipX, Prodigi, koszyki mieszane, backoffice, testy.

## 1. Executive summary

**Ogólna ocena: separacja na krytycznej ścieżce płatności (koszyk → checkout → webhook → fulfilment) jest zaprojektowana świadomie i działa poprawnie. Słabe punkty leżą poza happy-path: cykl życia zamówienia po opłaceniu (refundy, zwroty, backoffice, e-maile) oraz pokrycie testowe.**

Najważniejsze ustalenia:

1. **Koszyk mieszany jest twardo zablokowany po stronie serwera** (`validateCart` → `mixed_cart`, `src/lib/checkout.ts:71-73`), z lustrzaną blokadą w UI. To celowa decyzja architektoniczna, nie przypadek.
2. **Reguły dostawy są wymuszane na backendzie, nie tylko w UI**: printy wymagają `kurier` + adresu w kraju EU/UK (`src/app/api/checkout/route.ts:83-92`), ceramika kurierem tylko do Polski. Scenariusz „Polska + printy → InPost nie może być domyślny" **nie występuje** — paczkomat dla printów zwraca 400.
3. **Największe realne ryzyka**:
   - refund/przegrany dispute zamówienia printowego **nigdy nie anuluje zamówienia w Prodigi** — w repo nie istnieje żadna ścieżka anulowania Prodigi (strata pieniędzy: klient zrefundowany, Prodigi produkuje i fakturuje);
   - `/api/admin/create-shipment` **nie sprawdza typu zamówienia** — admin może utworzyć przesyłkę InPost dla zamówienia printowego;
   - dashboard admina pokazuje każde zamówienie printowe jako wiecznie „blocked"/„awaiting fulfillment", co wprost zachęca admina do kliknięcia powyższej błędnej akcji.
4. **Rozróżnianie typu produktu jest niejawne**: dyskryminatorem jest `order_items.variant IS NULL` (ceramika) vs `NOT NULL` (print) plus prefiks tokenu `print:` w koszyku. Brak kolumny typu na poziomie `orders`, a wartość `delivery_method='kurier'` jest przeciążona (kurier InPost dla ceramiki, kurier Prodigi dla printów).
5. **Pokrycie testowe ścieżki printowej jest niemal zerowe na poziomie route'ów**: cała gałąź printowa `/api/checkout`, routing webhooka do Prodigi, callback Prodigi i `enqueueProdigi` nie mają ani jednego testu; nie istnieje E2E zakupu printa.

## 2. Mapa repozytorium i flow zakupowego

| Obszar | Pliki / punkty wejścia |
|---|---|
| Produkty (ceramika) | `src/lib/products.ts` (rejestr statyczny, `PRODUCTS`, `PRODUCT_BY_ID`), stan sprzedaży w DB `piece_state` przez `src/lib/inventory.ts` |
| Produkty (printy) | `src/lib/prints.ts` (rejestr designów `fap01…`), `src/lib/print-cart.ts` (tokeny + `PRODIGI_SKU_MAP`), `src/lib/print-pricing.ts`, `src/lib/print-shipping.ts`, `src/lib/print-assets.ts` |
| Strony produktowe | `(pdp)`: ceramika → `ProductPageScreen` + `AddToCartButton.tsx`; printy → `PrintProductScreen` + `PrintConfigurator.tsx` (osobne wyspy, brak współdzielenia logiki add-to-cart) |
| Koszyk | `src/store/cart.ts` (flat `string[]`: `k01` lub `print:fap01:50x70:true:false:black`), `src/lib/cart-lines.ts` (`resolveCartLines` → tagged union `kind: 'ceramic' | 'print'`), UI: `src/components/shop/CartView.tsx` |
| Checkout | `src/app/api/checkout/route.ts` (walidacja, rezerwacja, PaymentIntent), `src/lib/checkout.ts` (`validateCart`), `src/lib/shipx.ts` (`validateDelivery`) |
| Shipping ceramika | `src/lib/pricing.ts` (`SHIPPING_PLN/EUR/GBP`, `DeliveryMethod`), `src/lib/shipx.ts`, `GeowidgetPicker.tsx` |
| Shipping printy | `src/lib/print-shipping.ts` (`PRINT_COUNTRIES` = EU+UK, `printShippingOf`) |
| Płatności | Stripe PI w `/api/checkout` (metadata: `delivery_method`, `has_prints`), webhook `src/app/api/stripe/webhook/route.ts` + `src/lib/webhook.ts` |
| Fulfilment ceramika | `src/lib/shipment.ts` (`createOrderShipment`), `src/lib/inpost.ts`, webhook InPost `src/app/api/inpost/webhook/route.ts`, zwroty `src/lib/return.ts` + `/api/returns` |
| Fulfilment printy | `src/server/fulfilment/enqueue.ts` → Cloudflare Queue → `process-job.ts` → `src/server/prodigi/{client,mapper,callbacks}.ts`, callback `/api/webhooks/prodigi/[token]` |
| Baza | `supabase/migrations/`: `piece_state`, `orders`, `order_items` (+`variant jsonb`), `fulfilment_jobs`, `prodigi_orders`, `pod_variants`, `private_sales` |
| Backoffice | `src/app/admin/`, `src/lib/admin/{data,fulfillment}.ts`, akcje `/api/admin/{refund,create-shipment,label,release-reservation,resend-confirmation}` |
| Cron/queue | `worker.ts` (expiry porzuconych zamówień, konsument kolejki Prodigi) |

## 3. Aktualny model rozróżniania produktów

Typ produktu **nie jest jawnym polem** — wynika z trzech konwencji:

1. **W koszyku**: prefiks tokenu — `isPrintToken()` (`src/lib/print-cart.ts:9`) rozpoznaje `print:` vs goły id ceramiki. Token printa jest walidowany strukturalnie przy dekodzie (`decodePrintToken`, w tym niedozwolone kombinacje rama/passe-partout).
2. **W zamówieniu**: `order_items.variant jsonb` — `NULL` = ceramika, `NOT NULL` = print (migracja `20260613120000_order_items_variant.sql`). Na tym dyskryminatorze opiera się routing fulfilmentu w webhooku (`webhook/route.ts:392-393`) i licznik under-fulfilment (`countCeramicOrderItems`, `src/lib/fulfillment.ts:17-25`).
3. **Pomocniczo**: metadata PI `has_prints: '1'` (`checkout/route.ts:202`) — tylko informacyjne, nic z tego nie czyta.

Ocena bezpieczeństwa mechanizmu:

- **Wystarczający na ścieżce płatności**, bo `validateCart` gwarantuje niezmiennik „całe zamówienie jest jednorodne", a webhook czyta dyskryminator z DB, nie z UI.
- **Niewystarczający poza nią**: brak kolumny typu na `orders` oznacza, że każdy konsument (admin, returns, e-maile, skrypty) musi samodzielnie dołączać `order_items.variant` — i większość tego nie robi (sekcja 5). Wartość `delivery_method='kurier'` znaczy dwie różne rzeczy (InPost vs Prodigi), a w DB **nie ma żadnego CHECK constraint** na `delivery_method` ani na spójność typu zamówienia (jedyny CHECK na `orders` to waluta).
- Kolumna `order_items.pod_variant_id` (FK do `pod_variants`) **nie jest nigdzie zapisywana ani czytana** przez kod aplikacji (grep po `src/` i `scripts/` — zero trafień) — martwa ścieżka; prawdą o SKU jest hardkodowana `PRODIGI_SKU_MAP`, a tabela `pod_variants` służy tylko skryptowi `sync-prodigi-skus`. Dwa źródła prawdy.

## 4. Shipping rule matrix

Uwaga: „produkty inne niż ceramika" = w tym repo wyłącznie printy fine art; nie istnieje trzeci typ produktu.

| Scenariusz | Oczekiwane metody dostawy | Obecne zachowanie w kodzie | Konflikt? | Pliki / funkcje | Rekomendacja |
|---|---|---|---|---|---|
| Polska + tylko ceramika | Paczkomat, kurier InPost (PL), odbiór osobisty | UI pokazuje wszystkie 3 (`CartView.tsx:565-593`), kurier z adresem hardkodowanym na PL (`CartView.tsx:315`); serwer wymusza `country_code === 'PL'` (`checkout/route.ts:88-91`) | Nie | `CartView.tsx`, `checkout/route.ts:83-92`, `shipx.ts:55` | Bez zmian; dodać testy route (§8) |
| Polska + tylko printy | Wyłącznie kurier Prodigi (adres domowy) | UI ukrywa paczkomat i odbiór (`{!hasPrints && …}`, `CartView.tsx:565,583`), wymusza `ship='kurier'` (`:229`); serwer: `hasPrints && (method !== 'kurier' \|\| !address)` → 400 (`checkout/route.ts:83-85`); PL jest w `PRINT_COUNTRIES` | Nie — InPost **nie** jest zakładany automatycznie | `CartView.tsx:229`, `checkout/route.ts:83`, `print-shipping.ts:12-16` | Bez zmian w regule; **brak testu** na odrzucenie paczkomatu dla printów — dodać |
| Polska + ceramika + printy | Zablokowane (osobne zamówienia) | UI: notice + disabled przycisk (`CartView.tsx:720,739`); serwer: 400 `mixed_cart` (`checkout.ts:71-73`) | Nie | jw. | Bez zmian; test route-level na `mixed_cart` |
| Polska + produkty inne niż ceramika | = przypadek „tylko printy" | jw. | Nie | jw. | Gdy pojawi się trzeci typ produktu, dzisiejszy binarny dyskryminator (`variant`/`isPrintToken`) przestanie wystarczać — patrz Phase 2 |
| Zagranica + tylko ceramika | Brak (ceramika tylko PL) | UI nie daje wyboru kraju dla ceramiki (adres zawsze PL); ręcznie spreparowany POST z zagranicznym adresem → 400 `invalid_delivery` (`checkout/route.ts:90`) | Nie, ale UX: brak komunikatu „ceramika tylko PL" | `CartView.tsx:315,664`, `checkout/route.ts:88-91` | Dodać jawny komunikat w UI; test na 400 dla `country_code !== 'PL'` |
| Zagranica + tylko printy | Kurier Prodigi do EU+UK | Selektor kraju ograniczony do `PRINT_COUNTRIES` (`CartView.tsx:248-250,664`); serwer `isPrintCountry` → 400 poza EU/UK (`checkout/route.ts:89`) | Nie | `print-shipping.ts:19` | Bez zmian; test na odrzucenie kraju spoza listy (np. US, CH) |
| Zagranica + koszyk mieszany | Zablokowane | jw. (`mixed_cart` niezależnie od kraju) | Nie | jw. | jw. |

**Wniosek z matrixu: reguły shippingowe są dziś poprawne i wymuszone serwerowo. Konflikty nie leżą w wyborze metody dostawy, tylko w tym, co dzieje się z zamówieniem po opłaceniu.**

## 5. Findings

### Finding 1: Refund/dispute zamówienia printowego nie anuluje zamówienia w Prodigi
* Severity: **High**
* Type: Bug (brakująca ścieżka procesu)
* Evidence: `releaseSale` w `src/app/api/stripe/webhook/route.ts:323-346` (tylko `orders.status → refunded` + relist `piece_state`, które dla printów nie istnieje); `/api/admin/refund/route.ts` (czysty `stripe.refunds.create`); grep po całym `src/` — **żadne miejsce nie woła anulowania zamówienia Prodigi** (`prodigi/client.ts` ma tylko `postOrder`/`getOrder`/`getProduct`).
* Description: Pełny refund lub przegrany chargeback zamówienia printowego zmienia status lokalnie, ale job Prodigi (`fulfilment_jobs` → `prodigi_orders`) biegnie dalej.
* Impact: Klient dostaje zwrot pieniędzy, a Prodigi drukuje, wysyła i fakturuje studio — bezpośrednia strata finansowa; klient może dodatkowo dostać produkt, za który nie zapłacił.
* Reproduction scenario: Kup print → zamówienie `paid`, job `fulfilment_submitted` → admin klika „Refund" (lub przychodzi `charge.refunded`) → w Prodigi zamówienie nadal `InProgress`.
* Recommended fix: W `releaseSale` (i po refundzie adminowym) dla zamówień z printami: jeśli `prodigi_orders.prodigi_status_stage` pozwala, wywołać Prodigi cancel API (`POST /v1/orders/{id}/actions/cancel` — do zweryfikowania w dokumentacji Prodigi); jeśli już wysłane — alert Sentry/e-mail do studia zamiast cichego no-op. Minimalnie: alert operacyjny „print refunded — cancel manually in Prodigi dashboard".
* Tests to add: unit `releaseSale` dla zamówienia printowego (mock klienta Prodigi: cancel wywołany dla stage anulowalnego, alert dla wysłanego); test webhooka `charge.refunded` z `variant != null`.

### Finding 2: `/api/admin/create-shipment` utworzy przesyłkę InPost dla zamówienia printowego
* Severity: **High**
* Type: Missing validation
* Evidence: `src/app/api/admin/create-shipment/route.ts:38-45` — guard tylko `isDeliveryMethod` + `needsShipment(delivery_method)`; zamówienie printowe ma `delivery_method='kurier'`, więc przechodzi. Webhook robi to poprawnie (`hasCeramics` z `order_items.variant`, `webhook/route.ts:392-402`) — admin route nie.
* Description: Ręczna akcja admina omija jedyny istniejący filtr typu (line-item variant).
* Impact: Fizyczna etykieta InPost kupiona dla zamówienia, którego studio nie wysyła; adres odbiorcy może być zagraniczny (ShipX kurier krajowy) → błąd lub koszt etykiety; zdublowany fulfilment (Prodigi i tak wysyła).
* Reproduction scenario: Print order wygląda w adminie jako „blocked" (Finding 3) → admin klika „Create shipment" → ShipX shipment powstaje.
* Recommended fix: W route przed `createOrderShipment` policzyć `order_items` z `variant IS NULL`; jeśli zero (print-only) → 409 z czytelnym komunikatem. To samo miejsce co guard `needsShipment`.
* Tests to add: rozszerzyć `create-shipment/route.test.ts` o case „print-only order → 409, InPost nie wywołany".

### Finding 3: Dashboard admina pokazuje zamówienia printowe jako wiecznie „blocked" / „awaiting fulfillment"
* Severity: **Medium** (eskaluje Finding 2)
* Type: Bug
* Evidence: `src/lib/admin/data.ts:183` (`!o.inpost_shipment_id && delivery_method !== 'odbior'` → `awaitingFulfillment++`); `src/lib/admin/fulfillment.ts:24-30` (`!inpost_shipment_id → 'blocked'`); `ORDER_COLUMNS` w `data.ts` w ogóle nie selektuje `order_items.variant` — warstwa admina jest ślepa na typ.
* Description: Print nigdy nie dostaje `inpost_shipment_id`, więc KPI i kolejka fulfilmentu traktują go jak ceramikę bez etykiety.
* Impact: Trwały szum operacyjny; fałszywy sygnał „zrób coś" prowadzący wprost do Finding 2. Rzeczywisty stan printa (w `fulfilment_jobs`/`prodigi_orders`) nie jest w kolejce widoczny.
* Reproduction scenario: Opłać print → wejdź na `/admin` → zamówienie wisi w kolejce jako `blocked` bez końca.
* Recommended fix: Dołączyć `variant` (lub flagę `has_prints`) do zapytań admina; print-only zamówienia kierować do osobnego stanu opartego o `fulfilment_jobs.status`/`prodigi_orders.prodigi_status_stage` (stage'y już istnieją w `status-map.ts`), wykluczyć je z KPI InPost.
* Tests to add: `fulfillment.test.ts` — print order nie trafia do `orderFulfillmentQueue` (lub trafia jako typ `prodigi` z własnym stage); `data.ts` KPI nie liczy printów jako awaiting.

### Finding 4: `/api/returns` akceptuje zamówienia printowe i tworzy zwrot InPost
* Severity: **Medium**
* Type: Missing validation
* Evidence: `src/lib/return.ts:49-52` — eligibility: `status='paid'`, `delivery_method !== 'odbior'`, brak istniejącego zwrotu. Brak sprawdzenia `variant`.
* Description: Print (paid + kurier) jest „eligible"; route buduje zwrot ShipX z klientem jako nadawcą do paczkomatu studia.
* Impact: Bezsensowna przesyłka zwrotna (print wysłał Prodigi, potencjalnie do Niemiec — nadanie w polskim paczkomacie niemożliwe); koszt etykiety; mylący e-mail ze zwrotną etykietą.
* Reproduction scenario: POST `/api/returns` z `order_id` opłaconego printa → zwrot InPost utworzony.
* Recommended fix: W `createOrderReturn` dodać warunek „zamówienie ma co najmniej jeden ceramiczny line item" (`variant IS NULL`); print-only → `not_eligible`. Polityka zwrotów printów to osobna decyzja biznesowa (§10).
* Tests to add: unit `createOrderReturn` z print-only orderem → `not_eligible`.

### Finding 5: E-mail potwierdzenia zamówienia ma treść ceramiczno-InPostową także dla printów
* Severity: **Medium**
* Type: Bug (UX/komunikacja)
* Evidence: `src/lib/email.ts` — `I18N_ORDER_CONFIRMATION` (m.in. „All orders in Poland will be shipped via InPost courier or InPost parcel lockers…", copy o logistyce lipcowej); wysyłany każdemu z `webhook/route.ts:254-261` i `/api/admin/resend-confirmation` bez rozróżnienia typu.
* Description: Kupujący print z Berlina dostaje potwierdzenie opowiadające o InPost i Polsce.
* Impact: Dezorientacja klienta, zgłoszenia do supportu, podważone zaufanie przy pierwszym zakupie printów.
* Recommended fix: Wariant treści dla print-orderów (fulfilment Prodigi, czas produkcji, dostawa kurierem w EU/UK) wybierany po `order_items.variant`.
* Tests to add: snapshot/unit builderów e-maili dla obu typów.

### Finding 6: Brak jakiegokolwiek e-maila wysyłkowego/trackingu dla printów
* Severity: **Medium**
* Type: Missing feature (asymetria domen)
* Evidence: `buildShippingConfirmation` w `src/lib/email.ts` wysyłany tylko z webhooka InPost (`/api/inpost/webhook`); callback Prodigi (`src/server/prodigi/callbacks.ts`) zapisuje status i `prodigi_raw_json` (gdzie siedzi tracking z re-fetchu), ale **nie wysyła nic do klienta** — grep po `tracking` w `src/server/` daje zero użyć.
* Impact: Klient printowy nie dostaje informacji „wysłano" ani numeru śledzenia; ceramika dostaje.
* Recommended fix: W `handleProdigiCallback`, przy przejściu na stage `Complete`/`shipped`, wysłać e-mail z trackingiem z `prodigiOrder.shipments` (guard `*_sent_at` analogicznie do istniejącego wzorca claim-once).
* Tests to add: unit callbacku — przejście na `shipped` wysyła e-mail raz (idempotencja na replay).

### Finding 7: Mail do studia o nowym zamówieniu gubi wariant/SKU printa
* Severity: **Low**
* Type: Bug
* Evidence: szablon obsługuje wariant (`src/lib/email.ts:249-250`: `it.variant ? …variantLabel… (prodigiSku)`), ale jedyny caller selektuje `'product_id, unit_price'` bez `variant` (`src/app/api/stripe/webhook/route.ts:225`); to samo w backfillu `scripts/reconcile-orders.mjs` (`select('product_id, unit_price')`).
* Impact: Studio widzi `fap01` bez rozmiaru/ramy/SKU — utrudniona kontrola zgodności z Prodigi.
* Recommended fix: Dodać `variant` do selecta w obu miejscach (jednolinijkowa zmiana).
* Tests to add: asercja w teście webhooka, że payload e-maila studia zawiera `variant` dla print-orderu.

### Finding 8: Brak jawnego typu zamówienia + przeciążone `delivery_method='kurier'`
* Severity: **Medium**
* Type: Architecture issue
* Evidence: brak kolumny `fulfilment_type`/`kind` na `orders` (migracje: jedyny CHECK to waluta, `20260705000000_orders_currency_usd_cad.sql`); `delivery_method` to zwykły `text` bez constraintu (`20260604160432_inpost_delivery.sql:11`); `'kurier'` znaczy „InPost kurier" dla ceramiki i „kurier Prodigi" dla printów.
* Description: Każdy nowy konsument danych zamówienia musi znać niepisany protokół „dołącz `order_items.variant` i sprawdź NULL". Findings 2–7 to w praktyce siedem instancji tego samego braku.
* Impact: Każda przyszła funkcja (raporty, nowy kanał sprzedaży, trzeci typ produktu) domyślnie odziedziczy błędną, ceramiczną interpretację.
* Recommended fix: Migracja `orders.fulfilment_type text not null check (fulfilment_type in ('inpost','prodigi','pickup'))` wypełniana w `/api/checkout` (wartość jest tam już znana: `hasPrints`/`method`), backfill z `order_items`. Opcjonalnie CHECK na `delivery_method`. Potem stopniowe przełączanie konsumentów z inferencji na kolumnę.
* Tests to add: test insertu z checkoutu (poprawny typ dla ceramiki/printów/odbioru), test constraintu.

### Finding 9: Martwa kolumna `order_items.pod_variant_id`; dwa źródła prawdy o SKU
* Severity: **Low**
* Type: Architecture issue / dead code
* Evidence: `20260626120001_pod_variants.sql:18` dodaje FK; grep po `pod_variant_id` w `src/` i `scripts/` — zero użyć. Checkout wpisuje SKU z hardkodowanej `PRODIGI_SKU_MAP` (`src/lib/print-cart.ts:105`), tabela `pod_variants` jest tylko celem skryptu `sync-prodigi-skus`.
* Impact: Mylące schema; ryzyko rozjazdu mapy hardkodowanej i tabeli (sync weryfikuje w jedną stronę).
* Recommended fix: Decyzja: albo wypełniać `pod_variant_id` przy checkoucie i uczynić `pod_variants` źródłem prawdy, albo usunąć kolumnę.

### Finding 10: Asymetryczny guard na PDP — ceramikę można dodać do koszyka z printami
* Severity: **Low**
* Type: UX gap (nie bug bezpieczeństwa — cart i serwer blokują checkout)
* Evidence: `PrintConfigurator.tsx:47,167-173` blokuje dodanie printa przy ceramice w koszyku (`print.mixedCart`); `AddToCartButton.tsx` (ceramika) nie ma świadomości printów — miks powstaje i jest łapany dopiero w `CartView` (`cart.mixedNotice`) i serwerowo.
* Impact: Klient dowiaduje się o konflikcie dopiero w koszyku — gorsze UX, symetria reguły złamana.
* Recommended fix: Lustrzany guard w `AddToCartButton` (`ids.some(isPrintToken)`).

### Finding 11: Zerowe pokrycie testowe printowej ścieżki serwerowej
* Severity: **High** (jako ryzyko regresji dla poprawnie działającego dziś kodu)
* Type: Missing test
* Evidence:
  - `src/app/api/checkout/route.test.ts` — **wszystkie** case'y to ceramika z `odbior`; gałąź `hasPrints` (`route.ts:79-112`: odrzucenie paczkomatu/odbioru, bramka krajów, koszt wysyłki framed/loose) nietestowana;
  - routing webhooka `hasPrints → enqueueProdigi` / `!hasCeramics → return` (`webhook/route.ts:392-402`) — nietestowany; `enqueueProdigi` niemockowany w testach route;
  - `src/server/prodigi/callbacks.ts` + `/api/webhooks/prodigi/[token]` — **zero testów**;
  - `enqueueProdigi` (`enqueue.ts`) — zero testów; happy-path `processJob` (POST → persist) nietestowany;
  - `/api/inpost/webhook` route — zero testów (tylko czysty `parseShipxWebhook`);
  - E2E: brak zakupu printa i brak koszyka mieszanego (`print-configurator.spec.ts` kończy się na add-to-cart).
* Impact: Reguły z §4 są dziś poprawne, ale nic nie chroni ich przed regresją.
* Recommended fix: patrz §8 (test matrix).

### Finding 12: Private sale × printy — zachowanie niezweryfikowane
* Severity: **Low**
* Type: Niejasność architektoniczna / wymaga weryfikacji
* Evidence: gałąź private-sale w `checkout/route.ts:156-173` przekazuje do `reserve_private_sale_pieces` pełne `ids` (dla printów byłyby to id designów, nie sztuk); brak jawnego guardu `privateSaleToken && hasPrints → 400`. Prawdopodobnie RPC odrzuci niedopasowany bundle (409/410), ale semantyka nie jest nigdzie zadeklarowana — **niepotwierdzone** bez lektury definicji RPC.
* Recommended fix: jawny early-return 400 dla tokenu private-sale z koszykiem printowym + test.

### Finding 13: Płaska stawka wysyłki printów niedoszacowuje zamówień wieloramowych
* Severity: **Low** (świadome, oznaczone)
* Type: Risk (biznesowy, już udokumentowany w kodzie)
* Evidence: `src/lib/print-shipping.ts:23-24` — `ponytail: flat per order — a multi-frame order costs Prodigi more than one quote; switch to live POST /quotes per cart if that gap starts to hurt.`
* Recommended fix: bez zmian do czasu sygnału z marż; monitorować różnicę quote vs pobrana wysyłka w zamówieniach >1 ramy.

## 6. Koszyki mieszane

**Status: celowo zablokowane i poprawnie obsługiwane — na trzech warstwach:**

1. PDP printa: przycisk disabled + komunikat, gdy w koszyku jest ceramika (`PrintConfigurator.tsx:167-173`);
2. Koszyk: `mixedCart` → notice `cart.mixedNotice` + disabled checkout (`CartView.tsx:720,739`);
3. Serwer: `validateCart` → 400 `mixed_cart` (`checkout.ts:71-73`) — UI jest lustrem, nie bramką.

Dodatkowo webhook jest defensywny: gdyby mieszane zamówienie jednak powstało, obsłużyłby oba fulfilmenty (`webhook/route.ts:397-402`), a `processJob` selektuje tylko print items (`.not('variant','is',null)`), więc ceramika nie może trafić do Prodigi.

**Rekomendowana decyzja architektoniczna: utrzymać blokadę.** Osobne trasy fulfilmentu, osobne koszty i czasy dostawy, osobna księgowość wysyłki — łączenie w jedno zamówienie wymagałoby split-orders po stronie serwera (dwa PI albo transfer split), co jest nieproporcjonalnie drogie wobec skali sklepu. Jedyne słabe punkty blokady to asymetria PDP (Finding 10) i brak testu route-level (Finding 11).

## 7. Backend validation

Ocena: **reguły są wymuszane serwerowo, niezależnie od UI** — to mocna strona repo:

- jednorodność koszyka: `validateCart` (`checkout.ts:71-73`);
- print ⇒ kurier + adres: `checkout/route.ts:83-85`;
- kraje: printy `isPrintCountry` (EU+UK), ceramika kurierem tylko PL: `checkout/route.ts:87-92`;
- rezerwacje tylko dla ceramiki (`ceramicIds`, `route.ts:78,174`), printy open-edition;
- routing fulfilmentu z DB (`order_items.variant`), nie z requestu: `webhook/route.ts:392-402`;
- under-fulfilment liczony tylko po ceramice: `countCeramicOrderItems`;
- `processJob` bierze wyłącznie print items i faluje bez adresu (`process-job.ts:68-71,78`).

Walidacje do dodania/wzmocnienia (miejsca, gdzie backend NIE wymusza reguł):

| Miejsce | Brakująca walidacja |
|---|---|
| `/api/admin/create-shipment` | guard „ma ceramiczne line items" (Finding 2) |
| `/api/admin/refund` + `releaseSale` | akcja/alert Prodigi dla printów (Finding 1) |
| `src/lib/return.ts` | print-only → `not_eligible` (Finding 4) |
| `checkout/route.ts` | jawne odrzucenie `private_sale_token` + printy (Finding 12) |
| schema DB | `orders.fulfilment_type` + CHECK na `delivery_method` (Finding 8) |

## 8. Test plan

**Unit (Vitest):**
- `checkout/route.test.ts` — nowe case'y: print cart + `paczkomat` → 400 `invalid_delivery`; print + `odbior` → 400; print + kurier bez adresu → 400; print + kurier `US`/`CH` → 400; print + kurier `DE` → 200 z `shipping = printShippingOf('DE', framed?)`; ceramika + kurier `DE` → 400; print PL → 200; mixed cart → 400 `mixed_cart`; framed vs loose stawka.
- `stripe/webhook/route.test.ts` — `variantRows` printowe: `enqueueProdigi` wywołany, `createOrderShipment` NIE; ceramika: odwrotnie; defensywny mixed: oba; `charge.refunded` dla printa (po wdrożeniu Finding 1: cancel/alert Prodigi).
- Nowe pliki: `enqueue.test.ts` (upsert idempotency, conflict re-select, queue send fail → throw), `callbacks.test.ts` (zły token 401, dedup done/lease, stage → status, brak lokalnego orderu → 500 + release claim, e-mail trackingu po `Complete` raz), happy-path `processJob` (claim → postOrder → persist prodigi_orders → `fulfilment_submitted`; 409-recovery).
- `return.test.ts` — print-only → `not_eligible`.
- `create-shipment/route.test.ts` — print-only → 409.
- `admin/fulfillment.test.ts`, `data.ts` — printy poza kolejką InPost / KPI.
- E-maile: builder potwierdzenia (wariant printowy treści), mail studia z wariantem+SKU.

**Integration:**
- pełny przepływ print: POST `/api/checkout` (mock Stripe) → insert `orders`/`order_items` z `variant` → symulowany `payment_intent.succeeded` → `fulfilment_jobs` row → `processJob` z mockiem Prodigi → `prodigi_orders`.
- przepływ ceramiczny analogicznie do ShipX mocka (częściowo istnieje w `shipment.test.ts`).

**E2E (Playwright):**
- `print-purchase.spec.ts`: konfigurator → koszyk pokazuje TYLKO „Dostawa kurierem" (asercja braku paczkomatu/odbioru i braku Geowidgetu), wybór kraju ≠ PL, płatność testowa, return page.
- `mixed-cart.spec.ts`: dodaj print, dodaj ceramikę z PDP → notice `mixed-cart-notice`, przycisk disabled; usuń print → checkout ceramiczny działa.
- rozszerzenie istniejącego ceramicznego speca o asercję, że selektor kraju NIE występuje.

**Webhook tests:** callback Prodigi (token, dedup, stage), InPost webhook route (parse + update + e-mail wysyłkowy tylko dla ceramiki).

## 9. Plan działania dla developera

### Phase 1 — Critical fixes
1. **Prodigi cancel/alert przy refundzie** (Finding 1): minimum — Sentry alert + e-mail do studia w `releaseSale`/`admin/refund` dla zamówień z printami; docelowo wywołanie Prodigi cancel dla anulowalnych stage'y. *(Jedyna pozycja, gdzie dziś realnie wyciekają pieniądze.)*
2. **Guard typu w `/api/admin/create-shipment`** (Finding 2) — kilkulinijkowa zmiana + test.
3. **Print-only → `not_eligible` w `return.ts`** (Finding 4) — jednolinijkowy warunek + test.

### Phase 2 — Architecture hardening
4. Migracja `orders.fulfilment_type` (`inpost` | `prodigi` | `pickup`) z CHECK, wypełniana w checkoucie, backfill z `order_items` (Finding 8); stopniowe przełączenie admina/returns/e-maili na kolumnę.
5. Admin: printy w osobnym torze kolejki (stage z `fulfilment_jobs`/`prodigi_orders`), poprawka KPI (Finding 3).
6. Jawne odrzucenie private-sale + printy w checkoucie (Finding 12).
7. Decyzja o `pod_variant_id`: wypełniać albo usunąć (Finding 9).

### Phase 3 — Test coverage
8. Testy route'owe checkoutu dla całej gałęzi printowej i bramek krajów (§8 — zamyka Finding 11).
9. Testy routingu webhooka (Prodigi vs InPost) + `enqueueProdigi` + callback Prodigi + happy-path `processJob`.
10. E2E zakupu printa i koszyka mieszanego.

### Phase 4 — UX and communication
11. Printowy wariant e-maila potwierdzenia (Finding 5).
12. E-mail wysyłkowy z trackingiem Prodigi na stage `Complete` (Finding 6).
13. `variant` w selectcie maila studia (webhook + reconcile) (Finding 7).
14. Lustrzany guard mieszania na `AddToCartButton` + komunikat „ceramika wysyłana tylko w Polsce" przy kurierze (Finding 10 + wiersz matrixu „zagranica + ceramika").

## 10. Open questions

1. **Refund printa a Prodigi**: czy studio chce automatycznego cancelu w Prodigi (gdy stage pozwala), czy tylko alertu i decyzji ręcznej? Jaka polityka, gdy print już wyprodukowany, ale niewysłany?
2. **Zwroty printów**: czy printy w ogóle podlegają zwrotom (POD zwykle nie, poza wadą)? Jeśli tak — jaki kanał (na pewno nie paczkomat InPost dla klienta z Niemiec)?
3. **Koszyki mieszane**: potwierdzić na stałe decyzję „dwa osobne zamówienia" (rekomendowana), czy w przyszłości split-checkout jednym przepływem płatności?
4. **Private sale**: czy linki private-sale mają kiedykolwiek obejmować printy? (Dziś de facto nie mogą — warto to zadeklarować jawnie.)
5. **Wysyłka wieloramowa**: przy jakiej skali zamówień >1 ramy przejść z płaskiej stawki na live `POST /quotes`?
6. **`pod_variants`**: ma zostać źródłem prawdy o SKU (i wtedy wypełniać `pod_variant_id`), czy pozostaje tylko narzędziem weryfikacji `PRODIGI_SKU_MAP`?
7. **Komunikat PL-only dla ceramiki**: czy zagraniczny klient ma widzieć jawną informację, że ceramika wysyłana jest tylko na adresy w Polsce (dziś UI po prostu nie daje wyboru kraju)?

---

**Metodologia i zastrzeżenia**: kluczowe pliki ścieżki checkout→webhook→fulfilment przeczytane bezpośrednio; UI, testy i backoffice zmapowane trzema równoległymi eksploracjami z wyrywkową weryfikacją. Jako **niepotwierdzone** oznaczono: zachowanie RPC `reserve_private_sale_pieces` dla id printowych (Finding 12) oraz dokładny kształt API anulowania Prodigi (Finding 1 — wymaga weryfikacji w dokumentacji Prodigi przed implementacją).
