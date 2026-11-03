# Realizacja planu copy i modelu sprzedaży — 2026-09-09

**Status: PL zaakceptowane 9 września 2026. Wdrożenie techniczne w toku; cały plan nie jest jeszcze wdrożony ani opublikowany.**

## Po akceptacji PL

- Zapis akceptacji w `docs/copy/2026-09-09/approval.json` i na nadrzędnej stronie pakietu Notion.
- `/sklep` przejął kolekcję printów; przekierowania 308 zachowują query i kotwice, PDP zachowują adresy. Zmieniono odnośniki menu, strony głównej, studia, CMS i breadcrumbs/sitemapę.
- Dodano wspólne dane studia, nazwę marki Studio oraz stany ceramiki we wszystkich czterech językach. Nie skopiowano jeszcze całego zatwierdzonego pakietu PL do runtime (treści o kartach wymagają funkcji).
- `/showroom` obejmuje wszystkie publiczne ceramiczne produkty, z osobną sekcją dostępnych online. Galeria wcześniejszych prac nie pokazuje cennika ani formularza podobnego przedmiotu; zawiera kontakt w sprawie wizyty.
- Odczyt dostępności obejmuje dropy, rezerwacje i status produktu. Awaria pozostawia galerię, blokując sprzedaż. Koszyk pobiera listę potwierdzonych dostępnych produktów; feed i JSON-LD wykluczają niedostępne oferty.
- Migracja `20260909120000_active_drop_purchase_guard.sql` dodaje atomowe sprawdzanie aktywnego dropu, zachowując ważne rezerwacje właściciela i ochronę prywatnej sprzedaży. Nie uruchomiono jej na produkcji.
- Test na izolowanym PostgreSQL 17 przeszedł: aktywny/zakończony/brak dropu, ukryty/sprzedany/brak produktu, ponowienia, rezerwacja ważna/wygasła, link prywatny, współbieżne zamknięcie dropu i uprawnienia.
- Build Next webpack oraz kontrola manifestów przeszły. Skierowane testy po poprawkach: 108/108. Pierwszy pełny zestaw: 2496 zaliczonych, 15 nieaktualnych oczekiwań; te oczekiwania poprawiono i odpowiedni zestaw 113/113 przeszedł. Pełny zestaw należy ponowić po pozostałych zmianach.
- Przeglądarka: pięć przekierowań 308, zachowanie query/kotwicy, canonical `/en/sklep`, brak zdublowanego linku i brak overflow przy 390 px — raport `implementation-browser-check.json`. Widok galerii pobrał język z istniejącego cookie; przed zakończeniem sprawdzić każdy język w osobnym kontekście.
- Saldo podłączono do checkoutu, webhooka Stripe, wydawania kart, koszyka i zadania odzyskiwania przerwanych operacji. Pełne pokrycie daje potwierdzenie chronione HMAC bez PaymentIntent. Dopłata ma własny identyfikator Stripe, a saldo jest księgowane atomowo z opłaceniem i sprzedażą ceramiki.
- Migracje `20260909130000`–`20260909170000`: księga/rezerwacje/zwroty, atomowe przygotowanie zamówienia, odzyskiwanie, migracja starych kodów i trwała blokada zmiany sposobu płatności dla tej samej próby. Wydawanie salda nie tworzy kodu promocyjnego. Migracja nie przywraca wartości wydanym wcześniej wykorzystanym lub wycofanym kodom; niejasne rezerwacje trafiają do sprawdzenia.
- Zwroty z salda: podział na pierwotne źródła, kolejne częściowe zwroty, uzgodnienie zwrotów ze Stripe i odzyskiwanie po przerwaniu. Administrator ma pełny zwrot i osobny endpoint częściowego zwrotu. Użyta karta jako przedmiot zakupu wymaga ręcznego sprawdzenia przed zwrotem. Spory Stripe dotyczące płatności z salda są obecnie kierowane do ręcznego rozliczenia.
- Podział płatności dodano do potwierdzenia, wiadomości klienta i studia, faktury, szczegółów konta, panelu i eksportu CSV. Karta jest źródłem płatności, a nie rabatem. Komunikaty nowego koszyka i zasady kart dostępne są w PL/EN/ES/DE.
- Nowy endpoint zwrotu nie generuje już etykiet InPost; zwraca instrukcję kontaktu. Formularz umożliwia kontakt bez konta i wskazuje adres na Teneryfie. Standardowe printy mają w JSON-LD 14-dniowe odstąpienie; historia etykiet pozostaje.
- Pełny zestaw z 13:04 lokalnie: **2537 testów zaliczonych, 2 pominięte**, lint bez błędów. Następnie testy checkoutu 69/69 i kontrola typów przeszły po dodaniu ochrony sposobu płatności. Najnowszy test PostgreSQL obejmuje też migrację starych kodów, zakaz ponownego uruchomienia ich jako promocji oraz blokadę zwrotu użytej karty. Nowy SQL sposobu płatności wymaga jeszcze dołączenia do tego testu.
- Next webpack z kontrolą manifestów przeszedł. Test przeglądarkowy `e2e/gift-card-balance.spec.ts`: **2/2 zaliczone** na lokalnym buildzie — pełne opłacenie bez Stripe i wyczyszczenie zakupionych pozycji; zachowanie identyfikatora przy nieznanym wyniku; brak kodu karty w URL i analityce. Endpointy mutujące były zastąpione odpowiedziami testowymi; nie wykonano płatności ani wysyłek.
- Saldo jest domyślnie zatrzymane przez `gift_card_settings.spending_enabled=false`. Żadnej nowej migracji, zmiany CMS ani kodu aplikacji nie opublikowano. Pozostają weryfikacja/review, pełna zgodność copy i e-maili, raportowanie konwersji dla salda, dokumenty/terminy dostaw, CMS/Notion i kontrolowany rollout. Nie zakończono starego dropu produkcyjnego.

Plan: [oryginał użytkownika](../plans/2026-09-09-studio-copy-sales-model.md). Skill prowadzący: `compound-engineering:ce-work`; pomocniczy: `copywriting`. Wykonanie lokalne, sekwencyjne zgodnie z AGENTS.md, na zastanej gałęzi `codex/copy-final`. Nie tworzono commitów ani nie publikowano sklepu.

## Wykonane

- Zachowano zastane zmiany `messages/{pl,en,es,de}.json`, `src/lib/email-addresses.ts`, `docs/README.md` i słownik. Do indeksu oraz słownika dodano dokumentację bieżącej pracy; pliki runtime pozostały nietknięte.
- Porównano słownik Notion z lokalnym: treści merytorycznie zgodne przed dopisaniem nowych decyzji z planu.
- Przygotowano kompletny plik propozycji PL o zachowanej strukturze 832 kluczy. Skrócono opisy wszystkich 41 wzorów Fine Art Print bez renumeracji; 39 pozostaje w kuracji, a dwa archiwalne nie są aktywowane.
- Dodano propozycje nowych stanów dostępności, karty z saldem, rozliczeń, e-maili, wymiarów oraz konkretnych CTA do obrazów na zamówienie, innych rozmiarów i współpracy z architektami.
- Odczytano 7 opublikowanych dokumentów CMS. Propozycje PL dotyczą 3: home v7, print-pdp v3, fine-art-prints v4. Zachowano media hero, nie nadpisano CMS. Pozostałe cztery dokumenty notes pozostają bez zmian.
- Powstał pełny rejestr z miejscem użycia, źródłem, zależnością publikacji i statusem akceptacji. Pola starego UI przewidziane do usunięcia mają osobne oznaczenie.
- Przygotowano projekty regulaminu, prywatności, dostawy, zwrotów i karty oraz listę konkretnych braków formalnych i operacyjnych. Brak potwierdzenia terminów nie został zastąpiony zmyśloną obietnicą.

## Weryfikacja

`node docs/copy/2026-09-09/build-preview.mjs` sprawdza zachowanie kluczy i indeksów, poprawność ICU oraz brak wybranych niedozwolonych sformułowań. Wykrył zastany tekst o Warszawie w opisie odbioru; poprawiono propozycję i powtórzono walidację. Wynik: 832 klucze, 1045 wpisów rejestru, 3 zmienione propozycje CMS. Kontrola ESLint generatora przeszła.

Podgląd sprawdzono w Chromium przy szerokościach 1365 i 390 px; wyszukiwanie `giftBalance` daje 24 wpisy, filtr zmian daje 473 wpisy. Wykryte przepełnienie długich adresów na telefonie naprawiono przez zawijanie tekstu; wynik końcowy zapisany w `copy/2026-09-09/browser-verification.json`.

Ścisła walidacja propozycji funkcją aplikacji `validateCmsPayload` początkowo odrzuciła historyczne `fap029` i `fap037` w opublikowanym dokumencie. Są wycofane z kuracji i obecny schemat nie dopuszcza ich do nowej publikacji. Pozostawiono ich pełną historię w `cms-before.json` i propozycje językowe w indeksach 28/36; przyszły payload CMS zawiera wyłącznie 39 przyjętych identyfikatorów. Po tej korekcie wszystkie 7 payloadów przeszło walidację. Nie zmieniono statusów produktów ani żadnego opublikowanego dokumentu.

Pełne testy aplikacji, build Next/OpenNext i E2E płatności nie potwierdzałyby tego etapu redakcyjnego: nie zmieniono kodu aplikacji ani mechanizmów płatności. Są nadal obowiązkowe po ich implementacji, przed ukończeniem całego planu.

## Bramka akceptacji

Sekcja 4 pkt 1 planu wymaga: „Przygotować teksty oraz podglądy do Twojej akceptacji”. Sekcja 4 pkt 5 uzależnia EN/ES/DE od akceptacji PL. Przygotowany pakiet jest konkretnym materiałem do tej decyzji; status żadnego nowego zdania nie został samodzielnie zmieniony na zaakceptowany.

Dokumenty formalne i kompletna polityka dostaw mają nadal jawne braki opisane w pakiecie. Zatwierdzenie stylu PL nie rozstrzyga tych braków i nie uruchamia funkcji.

## Kolejne wymagane etapy oryginalnego planu

1. Wspólne dane firmy i reguły dostawy; pełna macierz realizacji oraz formalne uzupełnienia dokumentów.
2. Dostępność ceramiki oparta na aktywnym dropie: UI, koszyk, checkout, linki prywatne, feedy i atomowe RPC. Błąd odczytu blokuje sprzedaż; wcześniej rozpoczęte płatności zachowują rezerwacje.
3. `/sklep` z printami, przekierowania 308 z zachowaniem parametrów i kotwic, wspólna ceramika w `/showroom`, SEO/sitemap/canonical/hreflang oraz podglądy CMS.
4. Księga salda kart, migracja starych kodów i kontrola płatności w toku; transakcyjne rezerwacje, pełne pokrycie bez Stripe i dopłata, odzyskiwanie realizacji, proporcjonalne zwroty, historia i raportowanie. Nie stosować zmiany samego `max_redemptions` jako zamiennika tej implementacji.
5. Nowe zwroty e-mailem do pracowni, z zachowaniem historii istniejących etykiet.
6. Po akceptacji PL przygotować EN/ES/DE, porównać nowsze źródła CMS/Notion, publikować skoordynowane zmiany; zamknąć istniejący drop w momencie uruchomienia zgodnie z poleceniem użytkownika.
7. Uruchomić pełne wymagane kontrole oraz zweryfikować opublikowany serwis, CMS, dokumenty, pocztę i feedy. Dopiero wtedy oznaczyć cały plan jako zakończony.

Nie przenosić planu do archiwum: praca pozostaje otwarta.
