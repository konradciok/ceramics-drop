# Audyt koszyka i checkoutu pod mobile — 2026-11-25

**Zakres:** `/koszyk` (CartView, CheckoutForm, GeowidgetPicker, SendcloudPointPicker, `site.css` § cart) na `origin/main` @ `4ceb2b1` + produkcja `anna-ciok.studio` w emulacji iPhone 13 (390×664 CSS px, Playwright), bez płacenia.
**Reguły:** `web-design-guidelines` (Vercel Web Interface Guidelines), `cro` → `references/form.md` (coreyhaines31/marketingskills), `ui-ux-pro-max` (priorytety touch/forms/layout).

## Pomiary (iPhone 13, koszyk z 2 kubkami)

| Metryka | Wartość |
|---|---|
| Wysokość viewportu | 664 px |
| Pierwsze pole formularza | 1086 px od góry (1,6 ekranu) |
| Przycisk „Przejdź do kasy” | 1676 px (2,5 ekranu) |
| Podsumowanie (kod rabatowy, karta podarunkowa) | 1824–2181 px — **pod** przyciskiem CTA |
| Wysokość dokumentu | 3439 px |
| Above the fold | nagłówek, 1 produkt; brak sumy i CTA |
| `<form>` wokół danych dostawy | brak |
| Pola z `font-size` < 16 px (auto-zoom iOS) | kod karty podarunkowej (14 px), kod rabatowy (14 px, `site.css:894`) |

## P0 — błąd produkcyjny

### 1. Zmiana kraju dostawy wywala cały koszyk — ✅ naprawione w #408 (zweryfikowane na produkcji 2026-11-25)
- **Repro:** odwiedzający z domyślnym krajem obsługiwanym przez Sendcloud (np. ES z IP) → zmiana kraju w selekcie (mobile: ES→DE; desktop: ES→PL) → ekran błędu „Coś się nie udało”, koszyk znika.
- **Przyczyna:** `src/components/shop/SendcloudPointPicker.tsx:158` — cleanup efektu woła `window.sendcloud.servicePoints.close()` bezwarunkowo; SDK (`removeServicePointPicker`) rzuca `TypeError: Cannot read properties of null (reading 'remove')`, gdy overlay nie był otwarty. Wyjątek w cleanupie zrywa drzewo Reacta.
- **Fix:** zamykać tylko gdy overlay był otwarty (ref `isOpen`) i/lub owinąć `close()` w `try/catch`. Dodać test (unmount bez otwarcia) + e2e zmiany kraju.
- **Sentry:** `CERAMICS-DROP-36` — 5 zdarzeń z 2026-11-25 13:10 to testy z tego audytu; realni klienci najpewniej jeszcze nie trafili, bo selekt kraju jest świeży.

## P1 — największy wpływ na konwersję mobile

### 2. Zablokowany CTA bez wyjaśnienia — ✅ PR `fix/checkout-inline-validation`
`CartView.tsx:1210` — przycisk jest `disabled` dopóki `deliveryReady` jest false, a formularz nie pokazuje żadnego błędu (np. `test@example` → szary przycisk, zero komunikatu). Na telefonie kupujący nie widzi, którego pola brakuje (Paczkomat jest zwykle ekran niżej).
**Fix:** przycisk aktywny zawsze; po tapnięciu walidacja → komunikat pod polem, `aria-invalid`, `aria-describedby`, przewinięcie i fokus na pierwszy błąd. Styl `[aria-invalid="true"]` już istnieje (`site.css:921`), ale nic go nie ustawia. Walidacja e-maila `onBlur`, nie przy każdym znaku.

### 3. Za długa droga do formularza i CTA — ✅ PR `feat/mobile-cart-layout` (zwarte wiersze, mniejszy H1, stały pasek płatności widoczny, gdy przycisk jest poniżej ekranu)
Na 664 px viewportu formularz zaczyna się na 1,6 ekranu, CTA na 2,5. Wiersz produktu zajmuje ~400 px (miniatura 4/5 + cena w osobnym wierszu, `site.css:848,860`), nagłówek H1 jest bardzo duży.
**Fix:** zwarty wiersz produktu na < 561 px (miniatura 56–64 px, nazwa + cena w jednej linii, „Usuń” jako ikona z `aria-label`), mniejszy H1; **przyklejony dolny pasek** z sumą i CTA (`position:sticky; bottom:0`, `padding-bottom: env(safe-area-inset-bottom)`), który przewija do pierwszego brakującego pola.

### 4. Podsumowanie pod przyciskiem i zdublowana lista produktów — ✅ PR `feat/mobile-cart-layout` (zwijany pasek podsumowania między produktami a formularzem, bez drugiej listy)
Poniżej 1101 px `aside.summary` renderuje się **pod** CTA: kod rabatowy i karta podarunkowa są niewidoczne przed kliknięciem „Przejdź do kasy”, a produkty są wylistowane drugi raz.
**Fix:** na mobile podsumowanie jako zwijany pasek „Podsumowanie · 233 zł ▾” nad formularzem (wzorzec Shopify), bez drugiej listy produktów; kod rabatowy i karta podarunkowa nad CTA.

### 5. Brak `<form>` wokół danych dostawy — ✅ PR `fix/checkout-inline-validation`
Klawisz „Dalej/Idź” na klawiaturze mobilnej nic nie robi, Safari słabiej rozpoznaje autouzupełnianie, pola nie mają `name`.
**Fix:** `<form noValidate onSubmit={handleCheckout}>` + `name` na każdym polu + `enterKeyHint="next"`/`"go"`.

### 6. Krok płatności: brak powrotu i brak skupienia na płatności — ✅ częściowo, PR `feat/payment-step` (podsumowanie dostawy tylko do odczytu + fokus/przewinięcie do „Płatność”; przycisk „Zmień” nadal otwarty)
Po utworzeniu PaymentIntent sekcje dostawy znikają bez podsumowania i bez „Zmień”; strona nie przewija ani nie przenosi fokusu na PaymentElement.
**Fix:** pokazać podsumowanie dostawy w trybie tylko do odczytu (imię, e-mail, punkt) + przewinięcie/fokus na nagłówek „Płatność”. Przycisk „Zmień” wymaga projektu: rezerwacja trzyma sztuki 15 min, więc edycja musi ponownie użyć tego samego `attemptId` (jak przy `invalid_delivery_point`), inaczej kupujący dostanie 409 na własną blokadę.

### 7. PaymentElement na ustawieniach domyślnych — ✅ PR `feat/payment-step` (appearance w barwach marki, accordion z radiami, „Zapłać {kwota}”)
`CartView.tsx:1200` / `CheckoutForm.tsx:35` — brak `appearance` (fonty/kolory Stripe ≠ marka), domyślny układ `tabs`, przycisk „Zapłać teraz” bez kwoty.
**Fix:** `appearance` z tokenów (`--c-espresso`, `--c-terracotta`, font body, radius 2px), `layout: { type: 'accordion', radios: true }` na mobile (BLIK / P24 / karta jako lista), przycisk „Zapłać 233 zł”.

## P2 — szczegóły formularza i dotyku

| # | Miejsce | Problem → poprawka |
|---|---|---|
| 8 | `CartView.tsx:1057` e-mail | ✅ podpowiedź literówki domeny w `feat/cart-interactions`. ✅ atrybuty w PR `fix/checkout-inline-validation` (podpowiedź literówek domeny — otwarte). Dodać `spellCheck={false}`, `autoCapitalize="none"`, `inputMode="email"`; podpowiedź literówek domeny (gmial.com → gmail.com) |
| 9 | `CartView.tsx:1067` telefon | ✅ placeholder z prefiksem kraju w `feat/cart-interactions`. `inputMode="tel"`; dla krajów spoza PL podpowiedź prefiksu (+34, +49…) albo pole kierunkowego — InPost/Sendcloud potrzebują poprawnego numeru |
| 10 | `CartView.tsx:1166` kod pocztowy | `inputMode="numeric"` dla PL + automatyczne formatowanie `00-000`; placeholder z przykładem zakończony „…” |
| 11 | `site.css:894` + karta podarunkowa | ✅ `fix/cart-polish`. `font-size:16px` na polach kodów (iOS zoomuje stronę przy < 16 px) |
| 12 | `MarketingOptInCheckbox` | ✅ `fix/cart-polish`. checkbox ma 13×13 px; powiększyć wizualnie do ≥ 20 px (cała etykieta jest już klikalna) |
| 13 | `ShipOption` (`CartView.tsx:86`) | ✅ `feat/cart-interactions` (natywne radio). `div role="radio"` z `tabIndex=0` na każdej opcji i bez strzałek → natywne `<input type="radio">` w `<label>`; przy jednej opcji (tylko Paczkomat) pokazać ją jako informację, nie wybór |
| 14 | Geowidget (`GeowidgetPicker.tsx`, `site.css:931`) | ✅ `feat/payment-step` (adres Paczkomatu) + `feat/cart-interactions` („Zamknij mapę” + preconnect). mapa 75 dvh w środku przewijanej strony łapie gesty (pułapka scrolla), brak przycisku „Zamknij”, po wyborze widać tylko kod punktu — adres jest pobierany (`address.line1`), ale nie wyświetlany. Fix: pełnoekranowy sheet z „Zamknij” + `overscroll-behavior:contain`, pokazać adres punktu, `preconnect` do `geowidget.inpost.pl` przy wyborze metody Paczkomat. *(Nie zweryfikowane wizualnie — przy zmianie kraju na PL wystąpił błąd P0 #1)* |
| 15 | Rozpraszacze | ✅ `fix/cart-polish` (pasek ogłoszeń i newsletter ukryte na `/koszyk`). na `/koszyk` pasek „Obrazy… — anna-ciok.com” wyprowadza ze sklepu, a stopka ma drugi formularz e-mail (newsletter). Na koszyku ukryć pasek ogłoszeń i uprościć stopkę |
| 16 | `CartView.tsx:957` „Usuń” | ✅ `feat/cart-interactions` („Cofnij” przez 8 s). natychmiastowe usunięcie unikatowej sztuki bez cofnięcia → toast „Usunięto · Cofnij” |
| 17 | `messages/*.json` `cart.promo.wrongTrackCeramics` | ✅ `fix/cart-polish` (tekst wskazuje anna-ciok.com). nieaktualny tekst „Ten kod obejmuje tylko grafiki fine-art.” (printy wycofane) |
| 18 | `site.css:857` | ✅ `fix/cart-polish`. miniatury w koszyku `object-fit:cover` przycinają zdjęcie (reguła projektu: naturalne proporcje) — w podsumowaniu jest już `contain` |

## Pomiar (CRO)
✅ Częściowo: `checkout_validation_error` (lista niepoprawnych pól) w PR `fix/checkout-inline-validation`. Lejek ma już eventy wyboru metody i punktu oraz `checkout_error`. Brakuje zdarzeń na poziomie pól (form.md § Measurement): fokus na pierwszym polu, błąd walidacji per pole, tapnięcie CTA przy niekompletnym formularzu. Bez nich nie da się zmierzyć efektu P1 #2–#5. Wzorzec: `buildEngagementEvent('checkout_field_error', { field })`, bez wartości pól (PII).

## Kolejność wdrożenia
1. **P0 #1** — osobny `fix:` PR od `origin/main` (mała zmiana + test).
2. **P1 #2 + #5** — `<form>`, walidacja inline, fokus na błąd, eventy pól.
3. **P1 #3 + #4** — zwarty layout mobile, sticky pasek z sumą, zwijane podsumowanie.
4. **P1 #6 + #7** — krok płatności (appearance, accordion, kwota na przycisku, podsumowanie dostawy).
5. P2 jako jeden PR porządkowy.
