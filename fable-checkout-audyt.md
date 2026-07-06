# Audyt pipeline'u zamówień: checkout → webhook → Supabase → Stripe → email → analytics

## Kontekst
Repozytorium: sklep ceramiczny (Next.js 16 App Router, Cloudflare Workers przez OpenNext, Supabase, Stripe, Resend, Meta CAPI/GA4 MP). Każde zamówienie przechodzi: POST /api/checkout → rezerwacja sztuk w Supabase (`reserve_pieces()`) → Stripe PaymentIntent → webhook Stripe → `orders`/`piece_state` w Supabase → e-mail (Resend) → server-side analytics (Meta CAPI/GA4) → cron co 15 min sprzątający porzucone zamówienia.

## Cel
Zweryfikować niezmienniki poprawności, idempotencji i bezpieczeństwa całego cyklu życia zamówienia. Zadanie wymaga trzymania całego cyklu życia requestu w jednym kontekście na raz — dlatego to jeden przebieg, bez dzielenia na fragmenty. To audyt czysto analityczny (read-only) — nie wprowadzać żadnych zmian w kodzie.

## Pliki do przeczytania
- `src/app/api/checkout/route.ts` + `src/app/api/checkout/route.test.ts`
- `src/lib/checkout.ts`
- `src/lib/pricing.ts`
- `src/app/api/stripe/webhook/route.ts` + `src/app/api/stripe/webhook/route.test.ts`
- `src/lib/webhook.ts` + `src/lib/webhook.test.ts`
- `src/lib/piece-release.ts`
- `src/lib/expire-orders.test.ts`
- `supabase/migrations/20260602213032_stripe_orders.sql`
- `supabase/migrations/20260615120000_private_sales.sql`
- `src/lib/email.ts`
- `src/lib/email-layout.ts`
- `src/lib/marketing/conversions.ts`
- `src/lib/marketing/meta-capi.ts`
- `src/lib/marketing/ga4-mp.ts`
- `worker.ts`
- `e2e/checkout-409.spec.ts`

## Niezmienniki do zweryfikowania

**Pieniądze/waluta**
- `chargeCurrency` jest wyliczana raz w `checkout/route.ts` (derywacja z ciasteczka) i nigdy nie jest ponownie odczytywana w webhooku. Zweryfikuj, że webhook zawsze ufa walucie zapisanej w `orders.currency`, a nie świeżemu odczytowi ciasteczka (które mogło się zmienić między POST a dostarczeniem webhooka).
- `stripe.paymentIntents.create` nie ma `idempotencyKey`. Zweryfikuj realny scenariusz podwójnego kliknięcia/retry sieciowego: czy może powstać drugi żywy PaymentIntent na te same zarezerwowane sztuki, i co faktycznie by to zablokowało (constraint na `orderId`? nic?).

**Maszyna stanów / idempotencja**
- Każde przejście `orders.status` (pending→paid, pending→failed, pending→expired, paid→refunded) musi być strzeżone warunkiem `WHERE status = <poprzedni>` (compare-and-swap). Zweryfikuj, że `releaseSale` (`charge.refunded`) i ścieżka `dispute.closed` mają tę samą gwarancję co `markPaid`/`expireOrder`.
- W `checkout/route.ts` błąd `stripe.paymentIntents.cancel()` jest połykany, gdy insert do `orders`/`order_items` się nie uda — sztuki są zwalniane, ale PaymentIntent może zostać żywy bez rekordu w DB. Ustal: co się dzieje, gdy webhook dla takiego osieroconego PI później przyjdzie (`markPaid`'s lookup po PI) — czy to głośno failuje/loguje się w sposób wykrywalny, czy ginie po cichu.

**Retry Stripe (webhook redelivery do 3 dni)**
- Które side-effecty webhooka są bezpieczne przy podwójnym doręczeniu: `markPaid`, `ensureInvoiced` (błędy połykane — sprawdź, czy to oznacza, że faktura nigdy nie powstanie przy trwałej awarii), `createShipment` (re-throw dla retry — sprawdź, czy częściowy sukces + rzucony wyjątek później nie tworzy dwóch przesyłek przy retry), `trackPurchase` (połykane błędy — sprawdź, czy `event_id = purchase-<payment_intent_id>` jest identyczny przy redelivery, żeby dedup po stronie Meta/GA4 faktycznie działał).
- Zła `STRIPE_WEBHOOK_SECRET` → 400 bez retry i bez alertingu. Sprawdź, czy istnieje jakikolwiek monitoring na wzrost 400 na tym route.

**Konkurencja**
- `reserve_pieces()` używa `SELECT ... FOR UPDATE` bez `SKIP LOCKED`. Zweryfikuj scenariusz deadlocku: dwa równoległe koszyki blokujące te same sztuki w różnej kolejności.
- Cron (`worker.ts`) vs spóźniony webhook — zweryfikuj dokładną kolejność: czy `expireOrder` sprawdza żywy status PI w Stripe przed próbą `cancel`, czy dopiero po niepowodzeniu.

**Analytics/e-mail**
- Zweryfikuj, że `event_id` dla eventu `purchase` jest identyczny po stronie przeglądarki (`/koszyk/return`) i serwera (`conversions.ts`) we wszystkich ścieżkach.
- Zweryfikuj, że treść e-maila (kwota/waluta/locale) pochodzi z zapisanego stanu zamówienia, nie z odczytu na żywo czegoś, co mogło się zmienić.

## Znane luki testowe (priorytet)
Brak testu: rollback przy niepowodzeniu zapisu zamówienia (PI cancel + zwolnienie sztuk); ścieżka auto-refundu przy under-fulfillment w `markPaid`; idempotency-key dla tworzenia PI (bo klucza nie ma); spójność waluty między `orders.currency`/`order_items.unit_price`/walutą PI; współbieżność SQL dla `reserve_pieces`; scenariusz osieroconego PI.

## Format wyniku
Lista findingów posortowana od najpoważniejszych, każdy: **severity** (confirmed bug / edge-case gap / theoretical-only) · **plik:linia** · **konkretny scenariusz repro** · **minimalna sugerowana poprawka**.
