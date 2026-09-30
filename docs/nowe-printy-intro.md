# nowe printy - intro

Stan rozpoznania: 28 września 2026. Cel: wprowadzić 16 nowych designów z `sklep_obrobione_2026` jako **nowe produkty**, zachowując konwencję ceramics-drop. To dokument przygotowawczy: nie utworzono produktów, nie zmieniono kodu aplikacji ani bazy, niczego nie opublikowano i nie wysłano do R2.

Ścieżki kodu i zasobów w tym dokumencie są względem katalogu głównego repozytorium ceramics-drop.
Folder wejściowy: `Prints/sklep_obrobione_2026` w zewnętrznym archiwum źródeł (poza repozytorium).

> Aktualna wersja dokumentacji jest śledzona w repozytorium. Sekcje „Aktualizacja” i „Punkt 2 wykonany” zapisują kolejne etapy i zastępują wcześniejsze informacje o brakujących źródłach, formatach i nieprzydzielonych ID.
> Definicje partii są w `config/print-assets/batches/2026-09-new-prints/`. Są przygotowaniem do importu, nie aktywną konfiguracją sklepu. Duże źródła pozostają w ignorowanym `design/`.

## 1. Co mamy na wejściu

Wszystkie poniższe pliki zostały sprawdzone lokalnie: **JPG, 8400 × 12000 px, przestrzeń sRGB, proporcja 7:10**. Jest to pomiar metadanych, nie ocena ostrości i jakości retuszu. Każdy obraz trzeba jeszcze obejrzeć w całości i w powiększeniu.

| Design | Plik w podfolderze designu |
|---|---|
| Aurora 01 | Aurora_01.jpg |
| Aurora 02 | Aurora_02_010.jpg |
| Aurora 04 | Aurora_04.jpg |
| Cirrus 01 | cirrus 01_print_A3.jpg |
| Cumulonimbus 03 | cumulonimbus 03.jpg |
| Cumulonimbus 06 | cumulonimbus 06.jpg |
| Cumulus 01 | cumulus 01.jpg |
| Cumulus 06 | cumulus 06.jpg |
| Obsidian 02 | obsidian_02_A2.jpg |
| Obsidian 03 | obsidian_03.jpg |
| Obsidian 04 | obsidian_04.jpg |
| Obsidian 05 | obsidian_05.jpg |
| Scopulus 02 | Scopulus_02.jpg |
| Tachylite 03 | tachylite_3_A3.jpg |
| Unda 04 | Unda_04.jpg |
| Unda 05 | unda.jpg |

Dla Unda 05 źródłem jest wybrany przez właściciela `Untitled-1.jpg`, przeniesiony i przemianowany na `unda.jpg`. Nie zastępować go innym eksportem. Nazwy A2/A3 w pozostałych nazwach są historyczne — aktualne wymiary wszystkich plików są jednakowe.

`nowy sklep_2026` przechowuje wcześniejszy wybór plików; do nowego wdrożenia punktem wyjścia są **obrobione** pliki. Obsidian 02 występuje raz.

## 2. Docelowy pakiet jednego produktu

Dla każdego designu potrzebne są:

- stabilny identyfikator produktu, nazwa źródłowa, numer wyświetlany, kolekcja i pozycja w niej;
- zatwierdzony master i źródła proporcji dla sprzedawanych formatów;
- konfiguracja przygotowania plików oraz manifest rewizji z wymiarami i SHA-256;
- pliki drukarskie w R2, rekordy zasobów w Supabase i przypisania do wszystkich aktywnych wariantów;
- główny obraz WebP, trzy mockupy ram i trzy obrazy lifestyle/detail, wraz z wersjami responsywnymi;
- indywidualne opisy PL/EN/ES/DE oraz zgodność ze wspólnymi informacjami o produkcie;
- produkty, warianty, media i opublikowane przypisanie do kolekcji w bazie;
- sprawdzona karta produktu, konfigurator, koszyk, ceny, metadane i feedy;
- status aktywny dopiero po kompletnym przygotowaniu i kontroli.

Przy obecnym standardzie bez passe-partout jest to **12 wariantów na design**: 3 rozmiary × (bez ramy + 3 kolory ramy). Warianty współdzielą **3 pliki drukarskie**. Zestaw internetowy ma 7 obrazów bazowych (hero + 3 ramy + 3 editorial), po 4 wersje każdego = **28 WebP na design**. Dla 16 designów oznacza to orientacyjnie 192 warianty, 48 JPG do druku i 448 WebP. To plan przy zachowaniu wszystkich formatów, nie liczba wykonanych zasobów.

## 3. Gdzie co jest przechowywane

| Warstwa | Miejsce i rola |
|---|---|
| Oryginały/eksporty tej partii | `Prints/sklep_obrobione_2026/<nazwa>/<plik>.jpg`; zachować jako źródło |
| Lokalne mastery aplikacji | Docelowo `design/uploads/master-images-prints/print-NNN/`; katalog `design/` jest ignorowany przez Git |
| Konfiguracja produktu | `config/print-assets/fapNNN.json`, śledzona w Git |
| Wynik przygotowania | `design/print-assets/<productId>/<revision>/`: pochodne, manifest i proofy; poza Git |
| Obrazy strony | `public/uploads/fap-NNN*.webp`, śledzone w Git, dostępne jako `/uploads/...` |
| Druk w R2 | `prints/<productId>/<revision>/<width>x<height>-<sha256>.jpg` |
| Hero i ramy w R2 | `prints/<productId>/gallery/<slot>/...`; klucze aktualizowalne |
| Dane produktów | Supabase: `products`, `product_variants`, `product_media` |
| Zasoby do realizacji | `print_fulfilment_assets`, `print_variant_asset_assignments` |
| Treści i kolekcje | `cms_documents` i wersje treści; `collections` / `collection_drafts`; nowszy CMS ma także `product_drafts` |

Odczyt R2 wykonany w tej rozmowie potwierdził dostęp przez MCP Cloudflare do `anna-ciok-print-assets`: 615 obiektów pod `prints/`, dla `fap001`–`fap041`, w tym 123 JPG i 492 WebP; około 1,48 GB. To stan zasobów, **nie potwierdzenie aktywności 41 produktów w bazie**. Nazw Aurora/Unda itd. nie ma w kluczach.

Lokalnie `public/uploads` zawiera 1148 plików `fap-*` (około 120,4 MB). **Aktualizacja po dodaniu katalogu `design/`: źródła robocze są już lokalnie dostępne.** Potwierdzono 41 folderów `print-001`–`print-041`, komplet 123 plików proporcji (3:4, 5:7, 7:10), 123 źródła scen editorial PNG oraz 41 plików opisów `print-NNN_desc.md`. Folder masterów zawiera 451 plików, około 4,23 GB. Dostępne są też 41 manifestów poprzedniej rewizji i szablony ram. R2 przechowuje pochodne; katalog `design/` pozostaje oddzielnym archiwum roboczym poza Git.

## 4. Identyfikatory, nazwy i kolekcje

Istniejący rejestr używa `fap001`–`fap041`, źródła `print-001`–`print-041` i pliki internetowe `fap-001...`. Nowe ID należy przydzielić dopiero po sprawdzeniu bieżącej bazy i R2. `fap042`–`fap057` to możliwy zakres dla 16 nowych pozycji, **nie dokonana rezerwacja**. Nie używać ponownie wycofanych ID i nie zmieniać tożsamości starych produktów.

Trzeba zapisać trwałą tabelę: nazwa źródłowa → productId → folder → noteIndex → kolekcja → numer/nazwa klienta → rewizja. Nie wyprowadzać ID z numeru widocznego w sklepie.

Obecnie `printDisplayName()` buduje nazwę z **nazwy kolekcji i kolejności produktu w niej**, np. „Linea 03”. Samo umieszczenie „Aurora 04” w nazwie JPG lub manifeście nie nada takiej nazwy w sklepie. Do ustalenia jest zachowanie nazw Aurora/Obsidian/Unda i numerów z lukami albo włączenie prac do istniejących kolekcji. Zachowanie dawnych numerów może wymagać zmiany modelu nazewnictwa.

Kodowy fallback kolekcji to `config/print-catalog-curation.json`. Bieżące odczyty kolekcji korzystają również z opublikowanych danych CMS: pola `kind=print-collection`, `slug`, `products` oraz nazwa. Zwykła kolekcja CMS bez tego znacznika nie pojawi się automatycznie w sekcjach printów. Nieprzypisane designy trafiają do „inne”.

`sync:fine-art-collections` aktualizuje członkostwo istniejących opublikowanych kolekcji (domyślnie dry-run, zapis przez `--confirm`). Nie tworzy nowych kolekcji. Dla nowych potrzebne jest osobne utworzenie i publikacja właściwego payloadu; dostępny jest również skrypt `backfill-fine-art-collections`, którego założenia trzeba sprawdzić dla nowego zestawu.

## 5. Przygotowanie do druku

Obecne konfiguracje są typu **fullBleed**: pipeline nie dokłada posterowych marginesów ani podpisu; skaluje przygotowane źródło danej proporcji. Białe pole lub podpis już obecny w grafice pozostaje częścią grafiki. Starszy tryb `poster` z osobnym SVG podpisu i marginesami jest nadal w narzędziach, ale nie jest aktualną konwencją tych 41 produktów.

| Rozmiar handlowy | Proporcja | Plik wymagany przez integrację |
|---|---|---|
| 30 × 40 | 3:4 | 3600 × 4800 px |
| 50 × 70 | 5:7 | 6000 × 8400 px |
| 70 × 100 | 7:10 | 8400 × 12000 px |

Obowiązuje mapowanie `assetPxFor()` / `PRODIGI_SKU_MAP`, a nie samodzielne przeliczenie centymetrów. Integracja uwzględnia m.in. wyjątek dla czarnej ramy 30 × 40.

Obecne eksporty pokrywają proporcję 7:10. Dla 3:4 i 5:7 trzeba przygotować i zatwierdzić osobne kompozycje. Nie rozciągać obrazu, nie przycinać automatycznie ważnych elementów ani podpisu. Wybór kadru, rozszerzenia istniejącego tła lub innego rozwiązania wymaga oglądu każdej pracy. Samo zmniejszenie obrazu 7:10 nie daje źródła 3:4. Alternatywą jest ograniczona oferta rozmiarów, po sprawdzeniu obsługi przez narzędzia.

Zalecane nazwy: `print-NNN__3x4.jpg`, `print-NNN__5x7.jpg`, `print-NNN__7x10.jpg`. Konfiguracja wymaga też klucza `2x3`, mimo że passe-partout jest wyłączone (`MOUNT_TEMPORARILY_DISABLED=true`, produkty mają `mountAvailable:false`). Obecne konfiguracje wskazują dla niego nieistniejący `NO_MOUNT_SOURCE_2026-08-17.jpg`; nie jest to plik do wygenerowania i sprzedaży. Sprawdzić zachowanie prepare dla aktywnych profili; nie włączać mount tylko po to, by zaspokoić stary onboarding.

Kontrola przed produkcją: kompozycja i podpis, ostrość, artefakty skalowania, banding, kolor, orientacja, marginesy. Obejrzeć wszystkie proofy; zachować sRGB i archiwum źródeł. Po zmianie źródeł lub konfiguracji ponownie przygotować manifest — hash blokuje użycie niezgodnych plików.

## 6. Konwencja mockupów — dwa odrębne zestawy

### A. Konfigurator: automatyczne ramy

`print-assets:mockups` komponuje zatwierdzoną pochodną 8400 × 12000 w istniejące puste szablony. Kolory: `black`, `natural`, `brown`. Bez passe-partout powstają trzy stany `framed-*`; stan bez ramy korzysta z hero.

Źródło geometrii i wyglądu: `config/print-assets/frames.json`. Tło `#F1EFEA`; naturalne drewno, czarna i ciemna drewniana rama. Pliki `black_wood_frame.png`, `natural_wood_frame.png`, `dark_wood_frame.png` są przewidziane w `design/print-assets/frames_blanks/`. Okna obrazu mają zmierzone współrzędne. **Szablony zostały dostarczone:** wszystkie sześć plików wskazanych w `frames.json` istnieje i odczytuje się jako PNG 1254 × 1254 px. Proporcje okien obliczone z metadanych i konfiguracji mieszczą się w tolerancji 2%: ramy około 0,696–0,698, mount około 0,664–0,666. Do tej partii potrzebne są trzy szablony bez mount. Weryfikacja obejmuje dostępność, metadane i geometrię; końcowy wygląd ocenić po kompozycji nowych mockupów. Używać plików wskazanych w konfiguracji, nie podobnie nazwanych kopii w głównym `design/`.

Skrypt emituje `fap-NNN-mock-framed-<kolor>.webp` i wersje 400/800/1600w, wysyła do R2 i zapisuje w `public/uploads`. Razem z plikami wdraża się `mockups:true` w rejestrze. Kafelki sklepu domyślnie używają ramy naturalnej. Mockupy są kanoniczne 7:10, a nie osobne dla każdego rozmiaru.

### B. Galeria editorial/lifestyle: trzy obrazy na design

Odnalezione pełne prompty: [mockups/prompts.md](./research/the-poster-club/mockups/prompts.md).

1. **Ściana ze światłem dziennym:** ciepły tynk/beż, cienka drewniana rama, prostokąt światła z okna, niewielki fragment fotela lub ceramiki.
2. **Aranżacja salonu:** neutralna sofa, cienka rama, mały stolik, książki i subtelny akcent roślinny; obraz pozostaje głównym tematem.
3. **Detal bez ramy:** zbliżenie oryginalnego wydruku z łagodnym wygięciem papieru na neutralnej tkaninie.

Domyślny kadr scen 4:5; neutralne materiały, naturalne światło, bez ludzi, dodatkowych obrazów, napisów i znaków wodnych. Bez passe-partout. Nie wymyślać faktury papieru ani cech produktu. Obejrzane istniejące `fap-001-life-01/02.webp` odpowiadają tej konwencji.

**Grafika jest niezmienną treścią produktu:** bez przerysowania, zmiany kolorów, proporcji, podpisu czy dopisywania elementów. Gdy generacja nie zachowuje wierności, przygotować pustą scenę i nałożyć oryginalny obraz. Tylko ujęcie detaliczne może pokazywać celowy wycinek źródła.

Źródła: `design/uploads/master-images-prints/print-NNN/print-NNN_mockup-01.png`, `-02.png`, `-03.png`. Skrypt `print-assets:editorial` **tylko konwertuje gotowe sceny**, nie tworzy ich AI. Wynik: `fap-NNN-life-01/02/03.webp` + wersje responsywne. Ten proces zapisuje pliki w `public/uploads`, **nie wysyła ich do R2**. Dodać `editorialGallery` w rejestrze i wdrożyć wraz z plikami.

WebP: kanoniczna szerokość maks. 1600 px, jakość 80, dodatkowo 400/800/1600w. Pole `mockups` i `editorialGallery` jest dołączane z rejestru kodowego również przy katalogu z bazy; wymagana jest zgodność głównej ścieżki obrazu w bazie i kodzie (`withRegistryMockups`). Sam zapis produktu w DB nie włącza tych galerii.

Dodatkowo dostępne są stare manifesty `design/print-assets/fapNNN/2026-08-17-r1/manifest.json`. Próbka `fap001` ma schemaVersion 2 i rendererVersion 3.0.0; manifesty są wzorcem i historią, nie plikami do skopiowania dla nowych designów. Nowa partia musi otrzymać własne hashe, productId i rewizję. Foldery `_incoming` i `_shared` nie są obecnie dostępne; starszy posterowy onboarding nie jest przez to gotowy do uruchomienia, ale nie są one konieczne do jawnych konfiguracji fullBleed.

## 7. Opisy i treści

Dostarczony katalog zawiera też **41 indywidualnych plików `print-NNN_desc.md`**. Odczytany przykład `print-001_desc.md` jest angielskim opisem zgodnym ze schematem: cechy obrazu → nastrój → rola we wnętrzu. Można użyć ich jako odniesienia stylistycznego; nie zakładać bez porównania, że są to treści obecnie opublikowane w CMS.

Odnaleziony system opisów:

- [agent-prompt.md](./research/the-poster-club/descriptions/agent-prompt.md)
- [template.md](./research/the-poster-club/descriptions/template.md)

Przed pisaniem obejrzeć konkretny obraz. Wybrać 2–4 wyróżniające cechy, przejść od kompozycji i kolorów do wiarygodnego nastroju i roli we wnętrzu. Standard z szablonu: jeden spójny akapit, zwykle 3 zdania, około 60–75 słów; mniej, gdy obraz nie uzasadnia rozwijania opisu. Bez domniemanej symboliki i intencji artystki, bez powtarzalnego marketingowego wypełniacza. W repo istnieją także krótsze opisy; szablon opisuje zalecany system, nie sztywny limit kodu.

Anna Ciok i watercolor + mixed media są podane jako metadane w promptcie repo. Fakty o papierze, gramaturze, trwałości, technice reprodukcji czy certyfikatach brać z zatwierdzonych danych produktu, nie z wyglądu obrazu. Treści ogólne o ramach, dostawie i artystce są odrębne (`page:print-pdp` / lokalizacje).

Przygotować 16 różnych opisów w **PL, EN, ES i DE**. Fallback znajduje się w `messages/{pl,en,es,de}.json`, w `notes['fine-art-prints']`; `noteIndex` jest zerowy i musi wskazywać właściwy opis. CMS może dostarczać opublikowane notatki po productId (`src/lib/cms/messages.ts`), używane też w karcie i metadanych. Pilnować zgodności fallbacku i opublikowanej treści. Samo uzupełnienie dowolnego pola `products.description` nie zastępuje automatycznie tej ścieżki.

Test `print-descriptions.test.ts` sprawdza komplet, brak pustych/placeholderowych opisów i duplikatów. Nazwę handlową uzgodnić zgodnie z sekcją 4; nie zakładać, że nazwa pliku steruje tytułem strony.

## 8. Zalecany przebieg wdrożenia tej partii

**Rekomendacja wynikająca z aktualnego kodu: użyć lokalnego pipeline CLI po usunięciu ograniczeń katalogu oraz blokady przygotowania zasobów dla draftów.** Nowszy CMS nie jest obecnie kompletną ścieżką dla nowych wieloformatowych designów (sekcja 9).

1. Odczytać aktualne produkty, warianty, kolekcje, własność CMS i ID w bazie. Potwierdzić docelowe środowisko. Odczyt R2 jest dostępny; dostępu i stanu produkcyjnej bazy nie weryfikowano w ramach tego dokumentu.
2. Uzgodnić mapowanie nowych ID, kolekcji i nazw. Zachować stare ID i historyczne zasoby.
3. Rozszerzyć rejestr/kurację i testy bez kasowania zabezpieczeń integralności. Poprawić `scripts/lib/db-variants.ts`, aby kontrolowane przygotowanie zasobów nowego draftu z poprawnymi aktywnymi wariantami było możliwe bez przedwczesnej aktywacji; sprawdzić również dalsze bramki pipeline. Przygotować konfiguracje, ścieżki mediów i fallback opisów. Wykorzystać dostarczone puste szablony ram z `frames_blanks/`.
4. Przygotować i obejrzeć źródła proporcji. Wygenerować lokalny plan/manifest; nie stosować starego onboardingu bez adaptacji.
5. Zarejestrować produkty i warianty przez istniejący mechanizm katalogu. `catalog:backfill` zapisuje całą projekcję atomowo i nowe printy kieruje do **draft**, nawet gdy kodowo są docelowo aktywne. Warianty muszą być aktywne do prepare; samo ustawienie starego `published:false` może stworzyć nieaktywne warianty. Trzeba rozdzielić gotowość wariantów od widoczności produktu w DB.
6. `prepare` → ogląd proofów → `upload` → `verify` → `publish` dla każdego produktu, jedna wspólna rewizja pokrywająca wszystkie jego rozmiary.
7. Wygenerować hero oraz ramy, przygotować trzy sceny editorial i skonwertować je. Dodać wszystkie ścieżki i flagi w rejestrze; sprawdzić spójność z mediami w bazie.
8. Uzupełnić cztery wersje językowe i przypisania do opublikowanych kolekcji. Sprawdzić ceny z aktualnej globalnej konfiguracji; nie tworzyć osobnego cennika przypadkowo.
9. Wdrożyć komplet kodu/plików strony, potwierdzić obecność obrazów i treści oraz gotowość wszystkich przypisań.
10. Aktywować produkt przez guarded status API/RPC dopiero po kontroli. Publikacja rewizji plików, publikacja treści/kolekcji, deployment strony i aktywacja produktu to **różne operacje**.
11. Sprawdzić stronę w 4 językach, konfigurator, koszyk, ceny, feedy i realizację na sandboxie. Zapisać wynik i rewizje w rejestrze partii.

Przykładowa kolejność operatora (szablon — nie uruchamiać przed krokami 1–5):

```bash
npm run print-assets:prepare -- --product <ID> --revision <REWIZJA> --dry-run
npm run print-assets:prepare -- --product <ID> --revision <REWIZJA>
# Ogląd i zatwierdzenie proofów; po zmianach ponowne prepare.
npm run print-assets:upload -- --product <ID> --revision <REWIZJA>
npm run print-assets:verify -- --product <ID> --revision <REWIZJA>
npm run print-assets:publish -- --product <ID> --revision <REWIZJA> --confirm <REWIZJA>
npm run print-assets:gallery -- --product <ID>
npm run print-assets:mockups -- --product <ID>
npm run print-assets:editorial -- --product <ID>
npm run print-assets:facets                       # kolory do filtra w /sklep (config/print-shop.json); CI wymaga koloru dla każdego opublikowanego designu
```

`upload` tworzy obiekty R2 i rekordy staged. `verify` pobiera zdalne bajty, sprawdza hash/wymiary i promuje do ready. `publish_print_asset_revision` atomowo przypisuje rewizję do wariantów. `update_product_status_guarded` sprawdza komplet gotowych zasobów przed aktywacją. Sam upload przez MCP nie wykonuje reszty procesu.

Wymagania operatora: Node 22 według runbooka, zależności repo, dostęp Supabase, dostęp Wrangler do R2 oraz do create-only uploadu dane S3 `R2_S3_ACCOUNT_ID`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`. MCP Cloudflare potwierdza odczyt obiektów, nie potwierdza automatycznie gotowości poświadczeń lokalnego CLI. Sekretów nie zapisywać w tym dokumencie.

## 9. Ograniczenia i rozbieżności znalezione w kodzie

| Problem | Konsekwencja i praca przed importem |
|---|---|
| `print-curation.ts` wymaga dokładnie 41 ID, 39 aktywnych mapowań i 9 konkretnych kolekcji; `prints.ts` również wymusza 41 pozycji | Samo dopisanie nowych produktów powoduje błąd. Rozszerzyć model i testy, zachowując unikalność, mapowanie i historię starych produktów. |
| Onboarding fullBleed nadal zakłada `NN → fap(NN+4)`, foldery liczbowe, cztery źródła i mountAvailable=true | Nie odpowiada obecnym folderom `print-NNN`, mapowaniu 1:1 i wyłączonemu mount. Dostosować helper albo przygotować jawne konfiguracje z walidacją. |
| Onboarding emituje stare wpisy `published:false`, a aktualny rejestr wyprowadza publikację z kuracji | Nie wklejać wyniku bez adaptacji do `SOURCE_PRINT_DESIGNS` i aktywnych wariantów w DB. |
| CMS tworzy produkty o ID `prd_...`; editorial CLI oczekuje `fapNNN`, mockupy korzystają z rejestru kodowego | Samo utworzenie produktu w CMS nie zapewni istniejącej obsługi galerii. |
| Zarówno `scripts/lib/db-variants.ts` (CLI), jak i `loadActivePrintVariants()` w CMS odrzucają produkt inny niż active | **Blokada pierwszej publikacji:** backfill tworzy draft, prepare wymaga active, aktywacja wymaga gotowych zasobów. Konieczna poprawka umożliwiająca przygotowanie zasobów draftu przy zachowaniu walidacji wariantów i guarded activation. Samo wybranie CLI nie rozwiązuje tej blokady. |
| CMS nadaje rewizję `cms-<uploadId>` dla pojedynczego uploadu/proporcji | Trzy proporcje tworzą osobne rewizje; publish wymaga jednej kompletnej. Kod wprost dokumentuje brak obsługi takiego multi-ratio publish. |
| Brak lokalnego `design/` — rozwiązany po dostarczeniu zasobów | Ramy oraz komplety trzech proporcji i trzech scen dla wszystkich 41 starych designów są dostępne. Nowa partia nadal wymaga własnych źródeł i scen. `editorial --all` sprawdza także stare designy; dla partii wygodniej używać wariantu per produkt. |
| Produkty edytowane przez CMS są pomijane przez backfill | Odczytać `skippedCmsOwnedIds`; nie zakładać, że backfill odświeży ich media czy warianty. |
| `docs/STATUS.md` ma historyczne wpisy o niewdrożonej kuracji, podczas gdy kod zawiera nowszy CMS | Stan produkcji potwierdzić odczytem DB/deploymentu. Nie utożsamiać planów, kodu ani liczby obiektów R2 z publikacją. |

## 10. Kontrola zakończenia i odwracanie zmian

- Źródła mają poprawne proporcje, proofy zostały obejrzane, każda grafika zgadza się z właściwym produktem.
- Każdy aktywny wariant ma gotowy, nieodwołany zasób o dokładnie wymaganych wymiarach; hash R2 zgadza się z manifestem.
- Hero, wszystkie oferowane ramy, trzy sceny oraz srcset działają bez 404; DB image i registry image są identyczne.
- Opisy są indywidualne i kompletne w czterech językach; nazwy, kolekcje i kolejność są zamierzone.
- Ceny EUR/PLN/GBP, warianty i SKU są zgodne z globalną konfiguracją; brak przypadkowego passe-partout.
- Karta, listing, koszyk, feedy Google/Meta, sitemap i metadane pokazują właściwy produkt. Zweryfikować podpisany URL do pliku oraz sandbox Prodigi bez tworzenia płatnego zamówienia produkcyjnego.
- Dla zmian kodu uruchomić odpowiednie testy kuracji, rejestru, opisów, pipeline i galerii, typecheck/lint oraz build; rozszerzyć oczekiwania liczebności, nie usuwać testów.
- Zachować tabelę ID, rewizję, manifest i wyniki kontroli. Korekta drukarska = nowa rewizja; nie nadpisywać content-addressed JPG. Wycofanie sprzedaży = status hidden/archived, z zachowaniem plików potrzebnych do dawnych zamówień. Galeria może być regenerowana osobno.

## 11. Decyzje do podjęcia przed wykonaniem

1. Czy klient ma widzieć oryginalne nazwy/numerację Aurora 01, Aurora 04 itd., czy nazwy i numerację istniejących kolekcji?
2. Czy tworzymy nowe kolekcje, czy przypisujemy prace do obecnych? Jaka kolejność?
3. Czy każdy design sprzedajemy we wszystkich 3 formatach i 3 kolorach ram? Domyślna propozycja: obecny standard, bez passe-partout.
4. Jak przygotować i zatwierdzić proporcje 3:4 i 5:7 dla każdej pracy?
5. Gdzie trwale archiwizować nowe źródła w ignorowanym przez Git `design/`? Szablony ram są już odzyskane i sprawdzone.
6. Czy wdrażamy partię przez dostosowany CLI (rekomendacja), czy najpierw rozbudowujemy CMS, aby obsługiwał nowe drafty, wiele proporcji i wszystkie galerie?

Nie trzeba odpowiadać na te pytania, żeby korzystać z dokumentu. Są punktami rozstrzygnięcia kolejnego etapu; niniejsza praca była rozpoznaniem i spisaniem procesu.

## 12. Źródła do dalszej pracy

Wszystkie poniższe ścieżki są względem repozytorium podanego na początku:

- `docs/print-asset-runbook.md` — kroki operatora, hashe, upload, verify, publish, galerie, recovery.
- `config/print-assets/fap001.json`, `config/print-assets/frames.json` — rzeczywiste konfiguracje.
- `scripts/lib/db-variants.ts` — blokada przygotowania draftów w lokalnym CLI.
- `src/lib/print-assets-prepare.ts`, `src/lib/print-assets-onboard.ts`, `src/lib/print-cart.ts`, `src/lib/print-availability.ts` — proporcje, onboarding i warianty.
- `src/lib/prints.ts`, `src/lib/print-curation.ts`, `config/print-catalog-curation.json`, `src/lib/print-collections.ts` — katalog i nazewnictwo.
- `src/lib/print-mockups.ts`, `scripts/print-assets-mockups.ts`, `scripts/print-assets-editorial.ts`, `scripts/lib/print-assets-storefront.ts` — wizualizacje i formaty.
- `docs/research/the-poster-club/mockups/prompts.md`, `docs/research/the-poster-club/descriptions/{agent-prompt,template}.md` — konwencja scen i opisów.
- `src/lib/catalog/{seed,repository,mappers}.ts`, `scripts/backfill-catalog.ts` — projekcja do DB i własność CMS.
- `scripts/{backfill,sync}-fine-art-collections.ts` — tworzenie/synchronizacja kolekcji.
- `src/lib/cms/messages.ts`, `messages/{pl,en,es,de}.json`, `src/lib/print-descriptions.test.ts` — treść i fallback.
- `src/server/asset-jobs/profiles.ts`, `src/server/asset-jobs/process-job.ts`, `src/server/cms-api/handlers/{products-create,jobs-publish}.ts` — aktualny pipeline CMS i ograniczenia.
- `docs/plans/2026-09-19-print-asset-pipeline-cutover.md` — kontekst rozwoju CMS; kod rozstrzyga, co zaimplementowano.
- `docs/prodigi-sku-catalog.md`, `src/lib/print-pricing-config/` — realizacja i ceny.

Źródła nie są w pełni zsynchronizowane; opisane wyżej rozbieżności to część wyniku rozpoznania, a nie pominięte kroki gotowego automatu.


## Aktualizacja: nowe źródła umieszczone w design

Skopiowano 16 obrobionych eksportów do `design/uploads/master-images-prints/print-042`–`print-057`. W każdym folderze są identyczne bajtowo pliki `print-NNN__7x10.jpg` oraz `print-NNN_70x100.jpg`, zgodnie z podwójnym nazewnictwem starszych źródeł. Zgodność wszystkich kopii ze źródłem sprawdzono SHA-256; eksporty w Prints pozostały na miejscu.

Numeracja folderów jest lokalna; nie zarejestrowano ani nie zarezerwowano productId w bazie. Nie utworzono brakujących proporcji, proofów, opisów ani mockupów. Mapa pochodzenia i hashe: `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-mapowanie.json`.

| Folder | Design |
|---|---|
| print-042 | Aurora 01 |
| print-043 | Aurora 02 |
| print-044 | Aurora 04 |
| print-045 | Cirrus 01 |
| print-046 | Cumulonimbus 03 |
| print-047 | Cumulonimbus 06 |
| print-048 | Cumulus 01 |
| print-049 | Cumulus 06 |
| print-050 | Obsidian 02 |
| print-051 | Obsidian 03 |
| print-052 | Obsidian 04 |
| print-053 | Obsidian 05 |
| print-054 | Scopulus 02 |
| print-055 | Unda 04 |
| print-056 | Unda 05 |
| print-057 | Tachylite 03 |

## Aktualizacja: pozostałe formaty przygotowane w Photoshopie

Dla wszystkich 16 nowych designów przygotowano 3:4 (3600 × 4800 px) i 5:7 (6000 × 8400 px). Eksporty JPEG jakości 12 z Adobe Photoshop 2026 mają osadzony profil sRGB i 300 DPI. W każdym folderze zapisano zarówno `__3x4.jpg` / `__5x7.jpg`, jak i identyczne kopie `_30x40.jpg` / `_50x70.jpg`. SHA-256 potwierdza, że oryginalne mastery 7:10 pozostały bez zmian.

Dla 13 designów usunięto wyłącznie pasy tła: po 400 px z góry i dołu źródła dla 3:4 oraz po 120 px dla 5:7, następnie zmniejszono obraz. Obejrzano źródła i podglądy końcowe z kontrolą grafiki i podpisów.

Aurora 01 (`print-042`), Aurora 04 (`print-044`) i Cumulonimbus 06 (`print-047`) mają grafikę dochodzącą do krawędzi. Za wyraźną zgodą właściciela zachowano cały obraz i dodano boczne marginesy w kolorze próbkowanego tła: po 120 px dla pliku 3600 × 4800 i po 60 px dla pliku 6000 × 8400. Bez rozciągania ani generatywnej zmiany grafiki.

Raport: `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-rozmiary.json`. Podglądy: `nowe-printy-podglad-3x4.jpg` i `nowe-printy-podglad-5x7.jpg` w tym samym katalogu. To źródła przygotowane do dalszego pipeline; nie są publikacją w R2 ani aktywacją produktów. Opisy, mockupy, konfiguracje produktów i import pozostają dalszymi etapami.


## Ustalone kolekcje nowych printów — 29 września 2026

Nowa partia jest grupowana według oryginalnych nazw serii. Nazwy kolekcji pozostają jednakowe w PL/EN/ES/DE. Zachowujemy oryginalne dwucyfrowe numery prac, w tym luki: Aurora 04 nie staje się Aurora 03, a Cumulus 06 nie staje się Cumulus 02. Kolejność wewnątrz kolekcji jest rosnąca według oryginalnego numeru. Roboczo nowe kolekcje dodajemy po istniejących, w kolejności poniżej, bez zmiany dotychczasowego katalogu.

| Kolekcja | Slug | Prace | Foldery |
|---|---|---|---|
| Aurora | `aurora` | Aurora 01, Aurora 02, Aurora 04 | print-042, print-043, print-044 |
| Cirrus | `cirrus` | Cirrus 01 | print-045 |
| Cumulonimbus | `cumulonimbus` | Cumulonimbus 03, Cumulonimbus 06 | print-046, print-047 |
| Cumulus | `cumulus` | Cumulus 01, Cumulus 06 | print-048, print-049 |
| Obsidian | `obsidian` | Obsidian 02, Obsidian 03, Obsidian 04, Obsidian 05 | print-050, print-051, print-052, print-053 |
| Scopulus | `scopulus` | Scopulus 02 | print-054 |
| Unda | `unda` | Unda 04, Unda 05 | print-055, print-056 |
| Tachylite | `tachylite` | Tachylite 03 | print-057 |

Definicje zapisano w `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-kolekcje.json`, a mapowanie źródeł uzupełniono o kolekcję, nazwę handlową, numer serii i kolejność. Są to przygotowane lokalne definicje, nie opublikowane rekordy CMS. `productId` pozostaje nieprzydzielony do czasu sprawdzenia bazy. Przy implementacji trzeba zmienić obecne wyliczanie nazwy z indeksu w kolekcji, tak aby używało jawnego numeru serii. Plik definicji partii nie jest gotowym payloadem API CMS.


## Punkt 2 wykonany: identyfikatory — 29 września 2026

Sprawdzono Supabase przez API projektu `wnlysejenowymjdxlnaq` i magazyn R2 `anna-ciok-print-assets`. Baza ma 41 istniejących printów: 39 aktywnych i 2 archived (`fap029`, `fap037`). Zakres `fap042`–`fap057` nie występuje w produktach, wariantach, mediach, draftach produktów, zasobach realizacyjnych ani przypisaniach zasobów; brak także obiektów R2 tego zakresu.

Przydzielono nowe ID w lokalnych definicjach partii i kolekcji:

| ID | Design | Folder |
|---|---|---|
| fap042 | Aurora 01 | print-042 |
| fap043 | Aurora 02 | print-043 |
| fap044 | Aurora 04 | print-044 |
| fap045 | Cirrus 01 | print-045 |
| fap046 | Cumulonimbus 03 | print-046 |
| fap047 | Cumulonimbus 06 | print-047 |
| fap048 | Cumulus 01 | print-048 |
| fap049 | Cumulus 06 | print-049 |
| fap050 | Obsidian 02 | print-050 |
| fap051 | Obsidian 03 | print-051 |
| fap052 | Obsidian 04 | print-052 |
| fap053 | Obsidian 05 | print-053 |
| fap054 | Scopulus 02 | print-054 |
| fap055 | Unda 04 | print-055 |
| fap056 | Unda 05 | print-056 |
| fap057 | Tachylite 03 | print-057 |

To przydział w przygotowywanej partii, a nie rezerwacja ani utworzenie rekordów w produkcyjnej bazie. W tym kroku wykonano wyłącznie odczyty zdalne. Przed importem ponowić sprawdzenie konfliktów. Wynik zapisano w `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-weryfikacja-id.json`. Ta aktualizacja zastępuje wcześniejsze uwagi o nieprzydzielonych ID i niezweryfikowanym stanie aktywności istniejących produktów.


## Punkt 3: poprawki kodu przed importem — 29 września 2026

Wprowadzono lokalnie możliwość rozszerzenia kuracji i rejestru ponad 41 designów oraz przygotowania plików dla produktów w statusie `draft`. Limit nazw/liczby kolekcji zastępują kontrole unikalności; nadal wymagane są spójne ID źródeł, pełne pokrycie rejestru, poprawna numeracja globalna i prawidłowe odwołania wycofanych prac. Test rozszerza istniejącą kurację o wszystkie 16 designów i 8 nowych kolekcji, pozostawiając dotychczasowe wpisy bez zmian.

CLI oraz planowanie zadań CMS dopuszczają `draft` i `active`, z wymaganiem aktywnych wariantów; `hidden` i `archived` pozostają blokowane. Renderowanie i promowanie zasobów nie aktywuje produktu. Guardy aktywacji/publikacji w bazie nie zostały zmienione. Ograniczenie wielu proporcji w jednej rewizji CMS pozostaje; dla tej partii nadal przewidziano CLI.

To poprawki mechanizmu, nie import: 16 nowych wpisów nie dodano jeszcze do aktywnego rejestru ani produkcyjnej bazy. Zachowanie nazw z oryginalnymi numerami serii oraz dostosowanie starego helpera onboardingowego pozostają częścią przygotowania właściwych konfiguracji/importu. Nie wdrożono kodu na produkcję.

Weryfikacja: pełny zestaw testów — 3619 zaliczonych, 2 pominięte; po końcowej korekcie asercji ponownie zaliczono wszystkie 35 testów przetwarzania zasobów. Kontrola typów, build webpack i kontrola katalogu w artefakcie buildu zakończone powodzeniem. Lint bez błędów, z jednym wcześniejszym ostrzeżeniem w niezmienianym teście backfillu kolekcji.

## Punkt 4: źródła i lokalny plan plików — 29 września 2026

Zweryfikowano 48 źródeł dla 16 prac: JPEG, osadzony profil sRGB, 300 DPI, właściwe proporcje i wystarczające wymiary. Sprawdzono identyczność 48 kopii nazwanych rozmiarami oraz zgodność hashy wszystkich 16 oryginałów 7:10 z wcześniejszym raportem. Ponownie obejrzano istniejące podglądy 3:4 i 5:7; zachowano zatwierdzone boczne marginesy w Aurora 01, Aurora 04 i Cumulonimbus 06.

Dodano konfiguracje `config/print-assets/fap042.json`–`fap057.json`, zweryfikowane przez rzeczywisty loader pipeline. Plan `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-plan-plikow.json` zawiera ścieżki, hashe, metadane oraz trzy planowane profile na produkt: 3600×4800, 6000×8400 i 8400×12000, pokrywające 12 wariantów bez passe-partout. Plan korzysta z lokalnej mapy SKU i `assetPxFor`; podczas właściwego `prepare` źródłem wymagań będą aktywne warianty zapisane w bazie.

Zgodnie z dotychczasową konwencją wymagane pole źródła 2:3 wskazuje celowo nieistniejący plik `NO_MOUNT_SOURCE_2026-09.jpg`. Passe-partout pozostaje wyłączone; jego przywrócenie wymaga nowego źródła. Nie uruchamiano starego helpera onboardingowego, nie generowano jeszcze finalnych pochodnych/proofów, nie zapisywano produktów w bazie ani plików w R2. Następną bramką jest przygotowanie wpisów katalogu i rejestracja draftów z aktywnymi wariantami, z zachowaniem oryginalnych numerów serii.

## Punkt 5: produkty robocze i warianty — 29 września 2026

Utworzono w produkcyjnym Supabase 16 produktów `fap042`–`fap057` w statusie `draft` i 192 aktywne warianty (po 12, bez passe-partout). Ponownie sprawdzono wolne ID w sześciu tabelach. Transakcyjny `backfill_catalog` otrzymał wyłącznie tę partię; porównanie pełnych wierszy przed/po potwierdziło, że wcześniejsze produkty, warianty i media nie zmieniły się. Raport: `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-import.json`.

Partię przygotowuje `scripts/lib/new-print-batch.ts` na podstawie kanonicznego seedowania wariantów fap041 (ten sam zestaw rozmiarów i ram), z kontrolą 12 wariantów oraz wymiarów. `scripts/stage-new-prints-2026.ts` domyślnie pokazuje lokalny plan; zapis wymaga `--apply`, sprawdza projekt, konflikty ID i stan po transakcji, a istniejący raport blokuje ślepe ponowienie. Ceny wariantów są standardowymi kolumnami seedowania; sklep nadal korzysta z globalnej konfiguracji cen.

Celowo zastosowano osobny seed partii zamiast dopisywania niegotowych produktów do publicznego rejestru fallback: nowe produkty nie powinny pojawić się przy awarii odczytu bazy. Nie dodano fikcyjnych ścieżek mediów. Nazwy z oryginalnymi numerami serii zachowano w `seo_title` i mapowaniu; opisy, tytuły CMS, kolekcje CMS, publiczny rejestr oraz reguła numerowania nazw w kolekcjach pozostają do uzupełnienia przed aktywacją. Dwa testy partii, kontrola typów i lint nowych plików przeszły.

## Punkt 6: pliki w R2 i przypisania — zakończony 29 września 2026

Przygotowano rewizję `2026-09-29-r1` dla wszystkich 16 draftów: 48 finalnych JPEG-ów (382 430 601 bajtów), 48 proofów i 16 manifestów w `design/print-assets/fap042`–`fap057`. Profile wyliczono z rzeczywistych 192 aktywnych wariantów w bazie. Nie przycinano ponownie źródeł; pipeline użył trzech wcześniej zatwierdzonych proporcji. Pełny lokalny preflight potwierdził zgodność konfiguracji, hashy źródeł i plików pochodnych oraz wymiarów. Raport: `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-przygotowanie.json`.

Zbiorczy podgląd wszystkich 48 proofów: `design/print-assets/2026-09-new-prints-review/index.html`. Studio zatwierdziło wszystkie podglądy 29 września 2026 („wszystko wyglada ok”), spełniając bramkę oglądu przed uploadem z `docs/print-asset-runbook.md`. Następnie wykonano upload → verify → publish dla całej rewizji. Wszystkie 48 plików jest w R2 `anna-ciok-print-assets`, pobrane bajty zweryfikowano względem manifestów, a 192 warianty otrzymały zgodne przypisania. Końcowy odczyt bazy potwierdził status `ready`, hashe, rozmiary, wymiary, klucze R2 i komplet przypisań. Wszystkie 16 produktów nadal ma status `draft`. Raport: `config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-r2-publikacja.json`. Nie aktywowano produktów ani nie wdrażano strony. Następny etap to galerie hero, mockupy ram i sceny editorial, a następnie treści oraz kolekcje.

## Punkty 7–8: galerie, opisy i kolekcje — zakończone 29 września 2026

Zweryfikowano dostarczone 48 scen editorial: trzy na każdą pracę, komplet nazw i zgodność przedstawionych grafik z oryginałami, zróżnicowanie wnętrz, kierunkowe światło oraz brak widocznych błędów montażu. Sceny mają 1536×2048 px (3:4); zachowano ich pełne kadry. Trzecie ujęcia pokazują detal arkusza, natomiast pełna grafika jest dostępna w hero i scenach z ramą. Nie generowano nowych scen. Raport źródeł, hashy i konwersji: `nowe-printy-2026-editorial.json` w katalogu partii.

W `public/uploads/` jest komplet **448 WebP** dla nowych produktów: 16 hero, 48 widoków ram i 48 scen editorial, każdy w wersji kanonicznej i wariantach 400/800/1600w (bez powiększania mniejszych źródeł). Rejestr ma ścieżki `editorialGallery` i flagi `mockups`. W bazie dodano 16 głównych mediów; tak jak dla wcześniejszych prac ramy i editorial są podłączane przez rejestr kodowy, nie powielane jako zwykła galeria DB.

Przygotowano **64 indywidualne opisy PL/EN/ES/DE** zgodne z systemem opisów i oglądem konkretnych prac. Są w `messages/*.json` oraz `nowe-printy-2026-opisy.json`; angielskie kopie zachowano w `print-NNN_desc.md`. Opublikowano nowe wersje dokumentu notatek CMS: PL 6, EN/ES/DE 4. Każda zawiera 55 opisów (39 wcześniejszych zachowanych bez zmian + 16 nowych). Utworzono i opublikowano osiem kolekcji z przypisaniami wszystkich nowych prac i krótkimi opisami w czterech językach. Wcześniejsze kolekcje oraz wiersze produktów pozostały niezmienione.

`seriesNumber` zachowuje oryginalne numery także przy kolekcjach odczytanych z CMS i zmianie kolejności prac. Wpisy nowej partii w mapie kuracji mają jawny `status: draft`: publiczny fallback ich nie pokazuje, ale warianty pozostają aktywne do przygotowania plików. Edytor i walidacja treści obejmują również te drafty. Raport zapisu i ponownego odczytu: `nowe-printy-2026-tresci-publikacja.json`.

Ceny zweryfikowano z aktualnego globalnego cennika Supabase, bez zmieniania go. Bez ramy: 30×40 **180 zł / 42 EUR / 36 GBP**, 50×70 **335 zł / 79 EUR / 68 GBP**, 70×100 **505 zł / 119 EUR / 102 GBP**. Z ramą: odpowiednio **390 zł / 91 EUR / 78 GBP**, **670 zł / 158 EUR / 136 GBP**, **925 zł / 218 EUR / 187 GBP**. Kolor ramy nie zmienia ceny. Historyczne kolumny cen w seedzie nie są źródłem cen checkoutu; nie nadpisywano globalnej konfiguracji wartościami domyślnymi kodu.

Podgląd galerii i tekstów: `design/print-assets/2026-09-new-prints-review/galerie-i-opisy.html`. Weryfikacja kodu: **3621 testów zaliczonych, 2 pominięte**, kontrola typów i build webpack wraz z kontrolą tras katalogu zaliczone; lint bez błędów, jedno wcześniejsze ostrzeżenie w teście backfillu kolekcji.

**Następny krok: commit i wdrożenie kompletnego kodu oraz plików strony, potem kontrola adresów mediów i treści.** Dopiero po tej kontroli aktywować 16 produktów przez guarded API/RPC i uzgodnić status aktywny również w mapie fallbacku. Aktualnie wszystkie 16 produktów nadal ma `draft`; nie wykonano deployu ani aktywacji. Nie ponawiać importu ani pełnego backfillu katalogu. Skrypt `scripts/complete-new-print-content-2026.ts` służy do kontroli tej partii (domyślnie tylko odczyt); zapis rozpoznaje istniejące zgodne dane i blokuje konflikty lub nowsze nieopublikowane treści.

## Punkty 9–11: wdrożenie i aktywacja — 30 września 2026

Po scaleniu PR #335 oraz poprawki testu integracyjnego #336 zweryfikowano produkcyjne wdrożenie Cloudflare (`8ce2df32-a548-4e7d-82ed-3c555df495cd`). Wszystkie **448 WebP** pobrane z `anna-ciok.studio` miały identyczne bajty jak wersje lokalne. Wszystkie **48 podpisanych adresów plików do druku** zwróciło HTTP 200, poprawny typ JPEG i zgodny rozmiar. Potwierdzono 192 aktywne warianty, przypisania do gotowych plików, 64 opisy i osiem opublikowanych kolekcji.

Następnie aktywowano **fap042–fap057** przez `update_product_status_guarded`, z kontrolą gotowości i audytem po stronie bazy. Ponowny odczyt potwierdził 16 aktywnych produktów i brak zmian pozostałych produktów. Raport `nowe-printy-2026-aktywacja.json`; operator `scripts/activate-new-prints-2026.ts` domyślnie wykonuje wyłącznie preflight, zapis statusów wymaga `--apply`.

Kontrola po aktywacji: **64 strony produktów** (16 × PL/EN/ES/DE) zwróciły HTTP 200, właściwą nazwę, dokładnie odpowiedni opis i konfigurator. Wszystkie nowe prace są na czterech wersjach listingu i w **ośmiu feedach** (Google i Meta × cztery języki). Sprawdzono również konfigurator i koszyk: Tachylite 03, 70×100 cm, czarna rama — 218 EUR plus 26 EUR dostawy do Hiszpanii. Testową pozycję usunięto, nie tworzono płatnego zamówienia. Raport: `nowe-printy-2026-kontrola-sklepu.json`.

Prodigi sandbox pobrał poprawnie wszystkie trzy reprezentatywne profile Aurora 01: 3600×4800, 6000×8400 i 8400×12000. Zamówienia `ord_1175344`–`ord_1175346` zgłosiły `downloadAssets: Complete`, bez issues. Testowe zamówienia anulowano po kontroli. Raport: `nowe-printy-2026-sandbox.json`. Jest to test pobrania zasobów w sandboxie, nie próba fizycznego wydruku.

Mapa kuracji została uzgodniona z aktywnymi statusami: 55 prac aktywnych, dwie archiwalne. Historyczne raporty poprzednich kroków nadal dokumentują ówczesny stan draftów; najnowszy stan opisuje ta sekcja i raport aktywacji.
