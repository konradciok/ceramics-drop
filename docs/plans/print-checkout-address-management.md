# Address management dla checkoutu printów

## Podsumowanie

- Wdrożyć wyłącznie dla zamówień printów natywny formularz adresu dostawy przed utworzeniem PaymentIntentu; flow ceramiki/InPost pozostaje bez zmian.
- Zachować istniejący Payment Element i sekwencję `adres → POST /api/checkout → client_secret → płatność`, dzięki czemu BLIK i Przelewy24 nadal działają.
- Nie używać Stripe Address Element. Wspólny deferred flow nie obsługuje BLIK-a, a standalone Address Element wymaga własnego Google Places key dla autocomplete. Natywne pola lepiej realizują wybrany browser autofill. Zobacz: [Stripe Address Element](https://docs.stripe.com/elements/address-element) i [Stripe payment-method support](https://docs.stripe.com/payments/payment-methods/payment-method-support).
- Użyć obecnego Zod 4; dodać `libphonenumber-js` i importować wariant `/min`.

## Implementacja

- Wydzielić `PrintDeliveryForm` z `CartView.tsx`, pozostawiając obecny formularz ceramiki nietknięty. Pola printów:
  - imię, nazwisko, email, telefon;
  - kraj;
  - `line1` — pełna ulica wraz z numerem;
  - opcjonalne `line2` — lokal, piętro itp.;
  - kod pocztowy i miasto.
- Umieścić pola w prawdziwym `<form>` z `name`, `required`, poprawnymi `type`, `inputMode` i tokenami autofill `section-print shipping ...`. Walidować na blur i submit, pokazywać lokalizowane błędy pod polami, ustawiać `aria-invalid` i przenosić fokus do pierwszego błędu.
- Kraj startowy ustalać w kolejności: szkic z `sessionStorage` → `CF-IPCountry`, jeśli należy do `PRINT_COUNTRIES` → `PL`. Zmiana kraju natychmiast przelicza widoczną wysyłkę, ale cena końcowa nadal pochodzi z serwera.
- Zapisywać wyłącznie dane printowego formularza pod wersjonowanym kluczem sesyjnym, np. `acc_print_delivery_v1`; usuwać je po potwierdzonym sukcesie płatności. Nie przechowywać adresu w `localStorage`.
- Po poprawnym `/api/checkout` zachować obecne zachowanie: zamrozić dane dostawy, zamontować Payment Element z `client_secret` i nie przechodzić na deferred Elements.

## Kontrakty i logika serwerowa

- Dodać współdzielony moduł `src/lib/print-delivery.ts` z typami i schematem:

```ts
type PrintShippingAddress = {
  line1: string
  line2?: string
  city: string
  post_code: string
  country_code: PrintCountry
}

type PrintDeliveryContact = {
  first_name: string
  last_name: string
  email: string
  phone: string // znormalizowane E.164
}
```

- Zod ma trimować dane i egzekwować: imiona 1–100 znaków, email maks. 254 i lowercase, surowy telefon maks. 50, `line1`/miasto 1–120, `line2` maks. 120, kod 1–20 oraz kraj z `PRINT_COUNTRIES`. Telefon parsować względem kraju, wymagać `isValid()` i zapisywać jako E.164. Nie dodawać kruchych regexów kodów pocztowych per kraj.
- W `/api/checkout` najpierw rozpoznać typ koszyka. Printy walidować nowym schematem, a ceramikę nadal przez `validateDelivery`. Zachować istniejące błędy: `invalid_contact`, `invalid_address` i `invalid_delivery`.
- Koszt dostawy i kwotę PaymentIntentu liczyć wyłącznie z serwerowo zwalidowanego kraju, zawartości koszyka i waluty cookie. Dane klienta nigdy nie określają ceny.
- Dla printów przekazywać znormalizowany adres także w `PaymentIntent.shipping`; nie zmieniać `payment_method_configuration`, idempotency ani polityki `receipt_email`.
- Zapisywać nowy kształt adresu printowego w istniejącym JSONB `orders.shipping_address`; migracja bazy nie jest potrzebna. Dodać kompatybilny helper odczytujący zarówno starszy ceramiczny `{street, building_number, ...}`, jak i nowy printowy `{line1, line2, ...}`.
- Użyć helpera w mapperze Prodigi, fakturach, adminie i eksportach. Prodigi ma otrzymać bezstratnie `line1`, opcjonalne `line2`, kod, miasto i kraj; email oraz telefon pozostają wymagane przez sklep, choć API Prodigi oznacza je jako opcjonalne i zalecane dla wysyłek międzynarodowych. Zobacz: [Prodigi API v4](https://www.prodigi.com/print-api/docs/reference/).
- Zachować istniejące kolumny CSV; dla printów wypełniać `address_street` wartością `line1`, pozostawiać `address_building` puste i dodać końcową, kompatybilną kolumnę `address_line2`.

## Testy i akceptacja

- Testy schematu: poprawne PL/DE/GB, normalizacja telefonu do E.164, błędny telefon względem kraju, niedozwolony kraj, opcjonalne `line2`, limity i tolerancyjny kod pocztowy.
- Testy `/api/checkout`: nowy adres jest normalizowany i zapisany, trafia do `PaymentIntent.shipping`, kraj ustala właściwą cenę, a błędne dane kończą się przed utworzeniem PI i zapisem zamówienia.
- Regresja ceramiki: Paczkomat, kurier PL i odbiór nadal korzystają z dotychczasowego kontraktu i mappera ShipX.
- Testy mapperów i prezentacji: nowy adres printowy oraz stare adresy ceramiczne poprawnie trafiają do Prodigi, faktury, admina, analityki i CSV.
- Playwright: autofill attributes, lokalizowane błędy, przywrócenie szkicu sesji, CF/PL fallback, zmiana kraju i ceny, courier-only print flow oraz pełny test karta → webhook → queue → Prodigi. Na preview wykonać dodatkowy ręczny smoke BLIK/P24 dla printu w PLN.
- Bramy końcowe: `npm run test`, `npm run typecheck`, `npm run lint`, testy `@ci` i istniejący destrukcyjny print-purchase przeciwko Prodigi sandbox.

## Założenia

- Checkout pozostaje guest, single-page i nie powstaje książka adresowa ani osobny adres billingowy.
- Payment Element sam zbiera wymagane przez wybraną metodę dane billingowe.
- Telefon jest wymagany dla każdego printu; region/state oraz walidacja rzeczywistej doręczalności przez zewnętrzne API pozostają poza zakresem.
- Nie zmieniamy listy obsługiwanych krajów ani obecnych statycznych stawek `printShippingOf`.
