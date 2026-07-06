# Audyt pipeline'u zamówień — 2026-07-06

Wykonanie audytu opisanego w `fable-checkout-audyt.md` (commit `15347a9`). Audyt czysto
analityczny (read-only) — żaden kod produkcyjny nie został zmieniony. Zakres: POST
`/api/checkout` → `reserve_pieces()` → Stripe PaymentIntent → webhook Stripe →
`orders`/`piece_state` → Resend → Meta CAPI / GA4 MP → cron sprzątający.

Stan kodu: branch `claude/fable-checkout-audit-0m6171` (HEAD = `15347a9`).

---

## Findingi (od najpoważniejszych)

### F1 · edge-case gap · `src/app/api/stripe/webhook/route.ts:109`
**E-maile potwierdzenia giną bezpowrotnie przy awarii Workera między CAS a wysyłką.**

Scenariusz repro: `markPaid` wykonuje CAS `pending→paid` (linie 40–48) i commit
przechodzi; isolate Workera ginie (eviction / timeout / deploy) zanim wykona się blok
e-maili (linie 141–180). Stripe redeliveruje `payment_intent.succeeded`; tym razem CAS
nie trafia żadnego wiersza, fallback znajduje order `paid` → `newSale = false` — a cały
blok e-maili (studio + klient) siedzi wewnątrz `if (newSale)` (linia 109). Klient nigdy
nie dostaje potwierdzenia, mimo że `confirmation_email_sent_at IS NULL` (strażnik, który
miał chronić przed duplikatami, nigdy nie dostaje szansy zadziałać przy retry).
Kontrast: konsumpcja tokenu private-sale została celowo wyniesiona POZA `newSale`
(linie 197–209) dokładnie z tego powodu — e-maile nie.

**Minimalna poprawka:** wynieść blok e-maila klienta poza `if (newSale)` — jest już
idempotentny przez `confirmation_email_sent_at`. Dla e-maila studia dodać analogiczną
kolumnę (`studio_email_sent_at`) albo świadomie zaakceptować stratę w tym oknie.

### F2 · edge-case gap · `src/app/api/stripe/webhook/route.ts:241-247`
**`releaseSale` połyka błąd UPDATE na `orders` — refund może nigdy nie relistować sztuki, bez retry i bez logu.**

Scenariusz repro: pełny refund → `charge.refunded` → `releaseSale`; UPDATE
`paid→refunded` zwraca przejściowy błąd DB. Kod destrukturyzuje tylko `{ data }` —
`error` nie jest sprawdzany. `rows` puste → `return false` → route odpowiada 200 →
Stripe NIE ponawia. Zamówienie zostaje `paid`, sztuka `sold` na zawsze, zero logów.
Kontrast: guard na `piece_state` w tej samej funkcji (linie 255–260) rzuca poprawnie;
`markPaid` (linia 50) też rzuca na `orderErr`.

**Minimalna poprawka:** odczytać `error` z odpowiedzi UPDATE i rzucić (5xx → retry
Stripe), lustrzanie do guardu z linii 260.

### F3 · edge-case gap · `src/lib/shipment.ts:124-131` + `route.ts:315-325`
**Częściowy sukces `createShipment` + retry = druga przesyłka InPost.**

Scenariusz repro: `inpost.createShipment` tworzy przesyłkę w ShipX, po czym
`saveShipment` (zapis `inpost_shipment_id`) failuje (błąd DB) → wyjątek → webhook 5xx →
Stripe redeliveruje → `loadOrder` widzi `inpost_shipment_id IS NULL` → powstaje DRUGA
przesyłka (i to ją kupuje `buyShipmentWhenReady`); pierwsza wisi osierocona w ShipX.
Idempotencja (`.is('inpost_shipment_id', null)` + gate na `LABEL_READY_STATUS`) chroni
każde okno POZA tym jednym: API-sukces-przed-DB-zapisem. Payload już niesie
`reference: order.id` (`shipx.ts:375`), więc duplikat jest wykrywalny po stronie ShipX.

**Minimalna poprawka:** przy `inpost_shipment_id IS NULL` najpierw przeszukać ShipX po
`reference = order.id` i zaadoptować istniejącą przesyłkę zamiast tworzyć nową.

### F4 · edge-case gap · `src/app/api/checkout/route.ts:111,156` (+ `CartView.tsx:314-319`)
**Brak `idempotencyKey` przy tworzeniu PI + świeży `orderId` na każdy POST: retry/druga karta self-409-uje i wycina koszyk kupującemu.**

Weryfikacja niezmiennika z audytu: **drugi żywy PaymentIntent na te same
zarezerwowane sztuki NIE może powstać** — blokuje to wyłącznie rezerwacja (drugi POST
dostaje świeży `orderId`, a `reserve_pieces` traktuje żywy hold jako konflikt → 409;
żaden constraint na `orders` w tym nie uczestniczy). Ale to samo zachowanie ma koszt:
double-click jest ogrodzony w kliencie (`submitting`, `CartView.tsx:291`), natomiast
(a) druga karta przeglądarki (koszyk współdzielony przez localStorage) albo (b) retry na
warstwie sieciowej POST-uje ponownie → własny hold czyta się jako konflikt → 409 →
`CartView.tsx:316` usuwa pozycje z koszyka i pokazuje „sprzedane”, mimo że pierwszy PI
żyje i jest opłacalny. Sztuki odblokują się dopiero po TTL (15 min) / cron (1 h).
Koszyki print-only nie mają rezerwacji wcale — duplikat POST tworzy dodatkowe wiszące
zamówienia+PI, które sprząta cron (bez podwójnego obciążenia: klient dostaje tylko
jeden `client_secret`).

**Minimalna poprawka:** klientowski identyfikator próby checkoutu przekazywany jako
`idempotencyKey` do `stripe.paymentIntents.create` i jako stabilny `p_order_id` do RPC;
`reserve_private_sale_pieces` już ma klauzulę idempotentnego retry
(`status='reserved' AND order_id = p_order_id`) — dodać ją też do `reserve_pieces`.

### F5 · edge-case gap · `src/app/api/stripe/webhook/route.ts:263-269`
**Trwała awaria `ensureInvoiced` = faktura nigdy nie powstaje, bez alertu; dla zamówień `odbior`/print-only także bez retry.**

Scenariusz repro: `createOrderInvoice` rzuca trwale (np. dryf wersji API / zmiana
zachowania invoices) → błąd tylko w `console.error`, bez Sentry (w odróżnieniu od
`conversions.ts`, który raportuje). Dla zamówień z wysyłką ratuje pośrednio
`createShipment` (rethrow → retry → ensureInvoiced odpala się ponownie), ale dla
`odbior` i print-only-success `createShipment` kończy się czysto → webhook 200 → koniec
retry. Nic nie monitoruje stanu `status='paid' AND invoiced_at IS NULL`.

**Minimalna poprawka:** `Sentry.captureException` w catchu + okresowy check (cron lub
widok admina) na opłacone-a-niezafakturowane zamówienia.

### F6 · edge-case gap · `src/app/api/stripe/webhook/route.ts:30-34`
**Zła `STRIPE_WEBHOOK_SECRET` → ciche 400 na każdy event; w kodzie zero monitoringu.**

Weryfikacja: `constructEventAsync` w catchu zwraca 400 `bad_signature` bez logu, bez
Sentry, bez metryki — grep po repo nie znajduje żadnego monitoringu tego route'a.
Rotacja sekretu w Stripe bez `wrangler secret put` zatrzymuje CAŁE fulfillment
(markPaid, e-maile, faktury, przesyłki) w sposób niewidoczny z aplikacji. Jedyny
zewnętrzny sygnał to alerty dashboardu Stripe („webhook failing”) + `stillActive`
warning z crona (worker.ts:41 — PI paid na pending zamówieniu), który zadziała dopiero
po ~1 h i wymaga czytania logów Workera.

**Minimalna poprawka:** `console.error` + `Sentry.captureMessage('stripe_webhook_bad_signature')`
w obu gałęziach 400 (brak podpisu / zły podpis).

### F7 · edge-case gap · `supabase/migrations/20260602213032_stripe_orders.sql:48-68`
**`reserve_pieces` nie sprawdza istnienia wierszy — niezasiany produkt „rezerwuje się” pusto, klient płaci i dostaje auto-refund.**

Scenariusz repro: produkt dodany do `products.ts` bez migracji seedującej `piece_state`
(dotychczasowe dropy seedowały: t16–t31, s03–s23, k27, black series — dyscyplina
istnieje, ale nie jest wymuszona). `reserve_pieces` nie znajduje konfliktów (brak
wierszy), UPDATE trafia 0 wierszy → „sukces”; klient płaci; `markPaid` liczy
`fulfilled < expected` → auto-refund + `failed`. Siatka bezpieczeństwa działa (brak
oversellu), ale każdy zakup takiego produktu to obciążenie i zwrot.
`reserve_private_sale_pieces` MA ten check (`v_found <> array_length`, linie 76–79) —
`reserve_pieces` nie.

**Minimalna poprawka:** ten sam guard istnienia w `reserve_pieces`, zwracający brakujące
idki jako konflikty (409 zamiast płać-i-zwróć).

### F8 · theoretical-only · `supabase/migrations/20260602213032_stripe_orders.sql:48`
**`SELECT … FOR UPDATE` bez `ORDER BY` — deadlock możliwy kontraktowo, w praktyce mało realny; skutkiem byłby 500, nie zawieszenie.**

Weryfikacja scenariusza z audytu: obie transakcje wykonują ten sam statement na tej
samej tabeli, więc kolejność blokowania wynika z planu (skan indeksu PK / seq scan),
nie z kolejności `p_ids` — dwa koszyki z tymi samymi sztukami w różnej kolejności
blokują w tej samej kolejności skanu. Deadlock wymagałby rozjazdu planów (lub przeplotu
z `reserve_private_sale_pieces`, który najpierw blokuje `private_sales`, ale piece'y
blokuje tym samym wzorcem). Gdyby jednak wystąpił: Postgres ubija jedną transakcję →
`reserveErr` → 500 `reserve_failed` (checkout route:144) — brak niespójności, klient
może ponowić.

**Minimalna poprawka (tania):** `ORDER BY product_id` w lockującym SELECT obu RPC —
gwarancja deterministycznej kolejności niezależnie od planu.

### F9 · theoretical-only · `src/app/api/checkout/route.ts:235` + `webhook/route.ts:62-67`
**Osierocony żywy PI po połkniętym `cancel` w rollbacku; webhook dla niego ginie po cichu.**

Weryfikacja scenariusza z audytu: insert `orders`/`order_items` failuje →
`try { cancel } catch {}` — jeśli cancel też failuje, PI zostaje żywy bez rekordu w DB.
**Klient nigdy nie dostał `client_secret`** (response to 500), więc PI jest nieopłacalny
przez sklep — brak ryzyka „pieniądze bez rekordu”. Cron go nie sprzątnie (nie ma wiersza
`pending`). Gdyby taki PI kiedykolwiek został opłacony (ręczny confirm w dashboardzie):
`markPaid` → CAS 0 wierszy → fallback `.single()` nie znajduje NIC → `return false` →
200 — całkowicie bez śladu. Ta sama ścieżka maskuje też każdy inny webhook o nieznanym
PI (np. z innego środowiska podpiętego pod ten sam endpoint).

**Minimalna poprawka:** zalogować błąd cancel z id PI (zamiast pustego `catch {}`) oraz
w fallbacku `markPaid` rozróżnić „order already processed” od „order NOT FOUND” i to
drugie logować/raportować do Sentry.

### F10 · theoretical-only · `src/app/api/stripe/webhook/route.ts:105`
**Zapis `failed` w ścieżce under-fulfillment bez CAS — wyścig z `charge.refunded` może zostawić status `failed` zamiast `refunded`.**

Scenariusz: auto-refund (linia 96) emituje `charge.refunded`; jeśli jego delivery
wyprzedzi linię 105, `releaseSale` zrobi CAS `paid→refunded`, po czym linia 105
(`update({status:'failed'}).eq('id', …)` — bez guardu statusu) nadpisze na `failed`.
Ścieżki zwalniania sztuk są wzajemnie idempotentne (obie honorują
`releaseTargetStatus`; druga trafia 0 wierszy), więc rozjeżdża się wyłącznie etykieta
statusu — kosmetyka w raportowaniu, bez skutków magazynowych.

**Minimalna poprawka:** `.eq('status', 'paid')` na tym UPDATE.

---

## Niezmienniki zweryfikowane pozytywnie

- **Waluta wyliczana raz i nigdy nie re-czytana.** `chargeCurrency` powstaje wyłącznie w
  `checkout/route.ts:58` (cookie → `toChargeableCurrency`); PI (`currency`, kwota),
  `orders.currency`, `order_items.unit_price` (validateCart z tą samą walutą) — spójny
  komplet z jednej derywacji. Webhook, e-mail (`formatGrosze(order.total,
  order.currency)`), faktura (`invoice.ts:85-86`) i konwersje (`conversions.ts:109,122`)
  czytają wyłącznie `orders.currency` — ciasteczko po POST nie ma już żadnego wpływu. ✅
- **CAS na wszystkich przejściach statusu:** `pending→paid` (route:43-44),
  `pending→failed` (route:217-218, z retry-safe re-fetchem), `pending→expired`
  (worker:100-101), `paid→refunded` (route:244-245). Wyjątki opisane w F2 (połknięty
  błąd) i F10 (zapis `failed` bez CAS). ✅
- **Redelivery Stripe (do 3 dni) jest bezpieczne:** `markPaid` idempotentny; claim
  sztuk i konsumpcja tokenu private-sale wykonują się także na retry; refund
  under-fulfillment ma `idempotencyKey: refund_${pi}`; `createOrderInvoice` re-czyta
  żywy stan faktury i używa per-order idempotency keys (przemyślane, patrz komentarz w
  `invoice.ts:22-40`); `trackPurchase` — patrz niżej. Jedyna niedomknięta ścieżka retry
  to e-maile (F1). ✅ z zastrzeżeniem F1/F3.
- **Dedup analytics działa przy redelivery i między przeglądarką a serwerem.**
  `event_id` = `purchase-<payment_intent_id>` po obu stronach: browser
  `analytics.ts:323` (orderNo defaultuje do PI id na `/koszyk/return:37`), serwer
  `conversions.ts:92`; GA4 `transaction_id` = PI id po obu stronach. `event_time` z
  `marketing.captured_at` — stabilny między redeliveries. Kruche założenie (przekazanie
  innego `orderNo` psuje dedup) jest udokumentowane w AGENTS.md i w komentarzu w
  `analytics.ts`. ✅
- **Cron vs spóźniony webhook — kolejność poprawna.** `cancelIntent` (worker:77-94)
  próbuje `cancel` NAJPIERW; status PI sprawdza dopiero po niepowodzeniu (Stripe i tak
  odmawia cancelu succeeded/processing). Expire tylko przy potwierdzonym `canceled`;
  wynik `paid` na pending zamówieniu → warning (detektor zgubionego webhooka). CAS na
  `expired`/`failed` eliminuje podwójne zwolnienie przy przeplocie z `releaseHold`. ✅
- **Treść e-maili wyłącznie z zapisanego stanu zamówienia** (wiersz `orders` +
  `order_items` ładowane w `markPaid`), nigdy z żywych odczytów cennika/cookie. ✅
- **Konkurencja rezerwacji:** lock-check-update w jednej transakcji plpgsql; przejęcie
  wygasłej rezerwacji vs spóźniona płatność rozstrzyga się spójnie w obu kolejnościach
  (sold-first → 409 dla drugiego; reserve-first → under-fulfillment auto-refund dla
  pierwszego). ✅
- **Private sale:** podwójna sprzedaż zablokowana trzema warstwami (RPC check na paid
  order, `consumed_at IS NULL`, partial unique index `private_sales_one_paid_order`);
  zwolnienia zawsze wracają do `sold` przez `releaseTargetStatus`. ✅

## Potwierdzenie luk testowych (z sekcji „Znane luki testowe”)

Wszystkie wymienione luki potwierdzone w kodzie testów:
- `checkout/route.test.ts` (6 testów): brak testu rollbacku przy niepowodzeniu zapisu
  zamówienia (cancel PI + zwolnienie sztuk, linie 233-241 route'a bez pokrycia).
- `webhook/route.test.ts` pokrywa wyłącznie `releaseHold` — ścieżka auto-refundu przy
  under-fulfillment w `markPaid` (route:94-107) bez żadnego testu.
- Brak testu idempotency-key dla PI (bo klucza nie ma — F4).
- Spójność `orders.currency` / `order_items.unit_price` / waluty PI testowana tylko
  pośrednio (wybór EUR/PLN per locale), bez asercji krzyżowej na jednym zamówieniu.
- Zero testów współbieżności SQL dla `reserve_pieces` (vitest nie dotyka Postgresa);
  brak też testu braku wiersza w `piece_state` (F7).
- Scenariusz osieroconego PI (F9) bez pokrycia.

Priorytet dopisania testów zgodny z severity findingów: F1 (retry-ścieżka e-maili),
F2 (błąd UPDATE w releaseSale), F3 (partial-success shipmentu), rollback checkoutu.
