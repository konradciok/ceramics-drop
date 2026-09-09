# Anna Ciok Studio — słownik i źródło prawdy dla copy

**Wersja:** 2026-09-09  
**Kopia w Notion:** [Anna Ciok Studio — słownik i źródło prawdy dla copy](https://app.notion.com/p/3d61bd1a6c8f8195a89cf4e86da6180d)  
**Status:** decyzje użytkownika obowiązują; przykładowe teksty i rozwiązania opisane jako propozycje czekają na jego zatwierdzenie. Ten dokument nie oznacza wdrożenia wszystkich zmian.  
**Zatwierdza treści:** użytkownik prowadzący tę rozmowę, w imieniu studia.  
**Zakres:** najpierw całe polskie copy, następnie EN/ES/DE. Strony, menu, stopka, karty produktów, konfigurator, koszyk, płatności, konto, zwroty, e-maile, dokumenty, metadane i dane strukturalne.

Źródłem decyzji są odpowiedzi użytkownika z 9 września 2026, w tym doprecyzowanie, że ceramikę można obecnie kupować wyłącznie podczas umówionej wizyty. Mają pierwszeństwo przed propozycjami z [audytu z 4 września](https://app.notion.com/p/3d11bd1a6c8f81afaffed4d998fed1f0). Nie oznacza to, że kod już realizuje każdą z tych decyzji.

## 1. Zatwierdzone zasady marki i języka

- Marka nadrzędna: **Anna Ciok Studio**. Anna Ciok pozostaje imieniem i nazwiskiem artystki. Docelowa nazwa marki w logo tekstowym, interfejsie, metadanych i e-mailach ma być spójna.
- Pierwszeństwo sprzedażowe mają **Fine Art Print**: reprodukcje oryginalnych obrazów Anny Ciok wykonanych akwarelą i tuszem, w kilku rozmiarach, z ramą lub bez.
- W opowieści artystki używamy pierwszej osoby liczby pojedynczej: „tworzę”, „maluję”, „odpisuję”. Informacje o zamówieniu podajemy neutralnie, np. „zamówienie zostanie wysłane”.
- Język spokojny, konkretny, bez personifikacji produktów i sztucznego podkreślania niedostępności. Status **„Sprzedane”** zastępuje „Już w nowym domu” i podobne zwroty.
- Nie podajemy klientom nazwy Prodigi ani nie objaśniamy roli partnera realizującego zamówienia. Nie zastępujemy tych informacji nieprawdziwą deklaracją, że Anna osobiście drukuje lub nadaje printy z Teneryfy.
- Nie komunikujemy podpisywania, numerowania egzemplarzy ani certyfikatów. Numer w nazwie produktu identyfikuje wzór; nie oznacza numerowanego egzemplarza lub limitowanej edycji.
- Następny drop zapowiadamy dopiero po ustaleniu szczegółów. Stałe copy nie obiecuje daty ani regularnej sprzedaży ceramiki.

## 2. Obowiązujący słownik

- **Fine Art Print** — nazwa produktu i etykieta oferty również w polskiej wersji. Nie zastępować nazwami „Odbitki Fine Art”, „Grafiki artystyczne” czy „Druki Fine Art”.
- **Reprodukcja obrazu wykonanego akwarelą i tuszem** — objaśnienie produktu. Słowo „reprodukcja” może wyjaśniać, czym jest Fine Art Print; nie jest równoległą nazwą kategorii.
- **Edycja otwarta** — dopuszczony termin w szczegółach produktu.
- **Druk giclée** — technika druku potwierdzona w dokumentacji produktu; należy odróżniać ją od techniki wykonania oryginalnego obrazu.
- **Przedmioty** — ogólne określenie ceramiki; można używać konkretnych nazw naczyń.
- **Sprzedane** — etykieta tylko dla przedmiotów faktycznie sprzedanych. Obecność w galerii wcześniejszych prac nie jest dowodem sprzedaży.
- **Z ramą / bez ramy** — podstawowy opis wariantów. Szczegóły passe-partout i koloru wynikają z rzeczywiście dostępnego wariantu.
- **Karta podarunkowa** — docelowo z zachowywanym saldem; publikacja obietnicy salda musi towarzyszyć działającej obsłudze salda.
- **Ceramika** — przyjęta w planie nazwa sekcji pod `/showroom`, łączącej publiczne przedmioty z dawnego sklepu i showroomu. Nowe teksty i układ pozostają do zatwierdzenia.
- **Napisz e-mail / Umów wizytę** — proponowane etykiety kontaktu odpowiadające rzeczywistej czynności.

W polskim copy utrzymujemy dokładny zapis „Fine Art Print”, bez samodzielnego przemianowywania na „Fine Art Prints”. Zdania można budować wokół „kolekcji Fine Art Print” lub „modeli Fine Art Print”. Nazwy kolekcji i produktów pozostają oryginalne we wszystkich językach.

Rozmiary standardowe w konfiguracji: **30 × 40 cm, 50 × 70 cm, 70 × 100 cm**. Redakcyjna propozycja: podawać centymetry bez dopisków A3+/B2/B1. Przy oprawie rozróżnić format nominalny od wymiarów zewnętrznych ramy i pola obrazu z passe-partout; nie nazywać wszystkich tych wymiarów „rozmiarem obrazu”.

## 3. Potwierdzone nazwy produktów

Sprawdzono 2026-09-09 w kodzie oraz w HTML publicznej [kolekcji](https://anna-ciok.studio/fine-art-prints), odpowiedź HTTP 200. Widocznych jest 39 różnych nazw:

- Ostrea 01–05
- Gestures 01–04
- Linea 01–04
- Horizons 01–05
- Portals 01–05
- Signs 01–04
- Ciala 01–04
- Balance 01–04
- Verticles 01–04

Pisownia **Ciala** i **Verticles** pozostaje bez zmian. Źródła: `config/print-catalog-curation.json` oraz `printDisplayName()` w `src/lib/print-curation.ts`. Funkcja numeruje nazwy osobno w każdej kolekcji. Globalne numery w mapie i stabilne identyfikatory `fapNNN` pełnią inną rolę; nie wolno ich renumerować przy redakcji copy. Publiczny odczyt nie potwierdza wykonania wszystkich wcześniejszych migracji ani gotowości każdego wariantu do zakupu.

## 4. Studio, kontakt i ceramika

- Miejsce życia Anny i siedziba studia: **Güímar, Teneryfa**.
- Nazwa firmy / sprzedawcy podana przez użytkownika: **Anna Ciok Studio**.
- Numer podatkowy podany przez użytkownika: **Y9608071L**.
- Miejsce rejestracji firmy: **Hiszpania, Wyspy Kanaryjskie**.
- Wspólny adres **pracowni, rejestracyjny i zwrotny**, potwierdzony przez użytkownika: **San Pedro Abajo 12, 38500 Guimar, Tenerife, Hiszpania (Wyspy Kanaryjskie)**. W tekstach opisowych można używać zapisu Güímar.
- Ceramikę można oglądać i kupować **wyłącznie podczas wcześniej umówionej wizyty w pracowni**. Nie deklarujemy obecnie sprzedaży zdalnej ani wysyłki ceramiki.
- Strona ceramiczna ma pokazywać przedmioty wcześniej dostępne w sprzedaży. Nie przedstawiamy całej galerii jako aktualnego stanu pracowni.
- Kontakt: **ania@ciok.art**.
- Instagram: [@anna.ciok.art](https://www.instagram.com/anna.ciok.art/).
- Facebook: [profil studia](https://www.facebook.com/anki.doodle.tenerife/).
- Zwroty obsługuje artystka pod podanym wyżej adresem pracowni. **Koszt odesłania przy zwykłym zwrocie pokrywa klient** — potwierdzone przez użytkownika. To ustalenie dotyczy zwrotu bez reklamacji.
- Nie ustalono wiążącego czasu odpowiedzi na wiadomości; nie wprowadzamy obietnicy „tego samego dnia”.

## 5. Oferta dodatkowa

Użytkownik potwierdził dostępność:
- obrazów malowanych na zamówienie;
- innych rozmiarów Fine Art Print na zamówienie;
- współpracy z architektami;
- karty podarunkowej z zachowywaniem salda jako wymagania docelowego.

Hurt nie został potwierdzony. Nie wyprowadzamy obietnicy hurtu z samej współpracy z architektami.

**Zakres karty — potwierdzony w kolejnym doprecyzowaniu:** standardowa oferta Fine Art Print w sklepie internetowym oraz ceramika, jeśli jest aktywny drop. Nie obejmuje obrazów na zamówienie, niestandardowych rozmiarów ani bieżącej sprzedaży podczas wizyt. Obecna ceramika jest dostępna wyłącznie w pracowni; przyszły aktywny drop może przywrócić sprzedaż internetową ceramiki.

## 6. Weryfikacja dostawy — notatka wewnętrzna, nie copy dla klientów

Sprawdzono kod, publiczną dokumentację producenta oraz nieodpłatne odczyty i wycenę API live. Nie utworzono zamówienia produkcyjnego. Nie odnaleziono w przejrzanych źródłach indywidualnej umowy SLA dla studia.

- `src/lib/print-shipping.ts` dopuszcza 27 państw UE i Wielką Brytanię. Szersza lista obsługiwana przez producenta nie jest automatycznie ofertą sklepu.
- Integracja wymaga adresu odbiorcy; dostawa Fine Art Print do paczkomatu nie jest oferowana.
- Mapper domyślnie wybiera `Budget`; ustawienie może zostać nadpisane przez `PRODIGI_DEFAULT_SHIPPING_METHOD`. Nie zweryfikowano wartości sekretów w uruchomionym Workerze.
- Cena dostawy w sklepie pochodzi ze stałej tabeli zależnej od kraju i tego, czy koszyk zawiera produkt z ramą. Jest naliczana raz na zamówienie i zaokrąglana w górę. Obecna konfiguracja dla Polski: **45 zł bez ramy / 78 zł z ramą**; odpowiednio **11 EUR / 19 EUR** lub **9 GBP / 16 GBP**. To wynik lokalnej konfiguracji, nie odczyt płatności produkcyjnej.
- Tabela opiera się na wycenach sandbox z 2026-07-03. Próbna wycena API live z 2026-09-09 dla jednej sztuki `GLOBAL-FAP-28X40`, do Polski, `Budget`, wykazała koszt wysyłki **17,80 EUR przed podatkiem** zamiast bazowych **10,45 EUR** zapisanych w tabeli. Wycena wskazała NL i DPD NL Classic. To pojedynczy scenariusz, nie pełna wycena wszystkich rynków i konfiguracji.
- API produktu live potwierdza dla `GLOBAL-FAP-12X16` papier EMA 200 g/m². [Specyfikacja papieru](https://www.prodigi.com/products/prints-and-posters/art-prints/enhanced-matte-art/) podaje druk giclée i produkcję 24–72 godziny. [Specyfikacja ram klasycznych](https://www.prodigi.com/products/wall-art/framed-prints/classic-frames/) podaje produkcję 72 godziny. Są to informacje o produkcji, nie całkowity czas doręczenia.
- [Zasady wysyłki producenta](https://support.prodigi.com/hc/en-us/articles/13168768147740-What-shipping-or-courier-options-are-there) wskazują, że Budget może być bez śledzenia; czas transportu dolicza się do produkcji. Nie obiecujemy śledzenia każdej przesyłki.
- [Kontrakt API](https://www.prodigi.com/print-api/docs/reference/) przewiduje przydzielanie zakładu zależnie od produktu, kierunku i usługi oraz możliwość kilku przesyłek. Kraj realizacji pojedynczej wyceny nie stanowi gwarancji dla wszystkich zamówień.
- `src/server/prodigi/merge.ts` obsługuje e-mail o nadaniu i zapis podstawowych danych śledzenia. Nie uzasadnia to obietnicy, że każda paczka ma tracking lub że konto pokazuje osobno wszystkie przesyłki.
- Nie potwierdzono dotychczasowego „5–10 dni roboczych” jako wspólnego terminu doręczenia całej oferty. Do uzupełnienia: realny przedział produkcja + transport dla obsługiwanych wariantów i kierunków oraz obsługa terytoriów szczególnych przy walidacji tylko kodem kraju.
- Polityka producenta wobec studia nie jest sama w sobie polityką zwrotów sklepu wobec klienta. Dokumentów konsumenckich nie uznajemy za zatwierdzone.

## 7. Rozbieżności wymagające działania w produkcie

1. **Saldo karty:** `src/lib/gift-cards.ts` tworzy kod z `max_redemptions: 1`; `docs/gift-cards.md` opisuje utratę nadwyżki. Docelową decyzją jest zachowywanie salda. Trzeba skoordynować zmianę obsługi płatności i salda z tekstem karty oraz zasadami jej użycia. To nie jest gotowa funkcja potwierdzona przez ten dokument.
2. **Ceramika poza aktywnym dropem:** obecnie sprzedaż odbywa się tylko w pracowni; przyszły aktywny drop może udostępnić ceramikę online, także z płatnością kartą podarunkową. Katalog, koszyk, checkout, feedy i linki muszą respektować ten stan, zachowując historię zamówień i prawdziwe statusy przedmiotów. Nie usuwać mechanizmu przyszłych dropów.
3. **Koszt i termin dostawy:** klient płaci według konfiguracji sklepu. Przed obietnicą „koszt bez marży” lub konkretnym terminem trzeba zweryfikować aktualne dane. Nie zmieniono cen w tej sesji.
4. **Treści w kilku źródłach:** runtime korzysta z `messages/*.json`, CMS i danych katalogowych. Sama zmiana tłumaczeń nie gwarantuje zmiany opublikowanego CMS. Zbadać zarówno źródło, jak i wynikowy HTML, e-maile i JSON-LD.
5. **Dokumenty formalne:** użytkownik podał nazwę sprzedawcy, numer podatkowy, miejsce rejestracji oraz wspólny adres pracowni, rejestracyjny i zwrotny. Potwierdził również, że koszt odesłania przy zwykłym zwrocie bez reklamacji pokrywa klient. Gotowe zasady zwrotów i dokumenty nadal wymagają zatwierdzenia. Decyzja o niewymienianiu partnera w copy nie jest potwierdzeniem kompletności dokumentów prawnych.

## 8. Przykładowe polskie copy do zatwierdzenia

**Strona główna — tytuł:** Fine Art Print  
**Opis:** Reprodukcje moich obrazów malowanych akwarelą i tuszem. Wybierz rozmiar oraz wersję z ramą lub bez.  
**Przycisk:** Zobacz kolekcję

**Szczegóły produktu:** Fine Art Print na podstawie oryginalnego obrazu Anny Ciok wykonanego akwarelą i tuszem. Druk giclée na matowym papierze artystycznym 200 g/m². Edycja otwarta.

**Ceramika:** Poznaj przedmioty z moich wcześniejszych kolekcji. Aktualnie dostępną ceramikę możesz obejrzeć i kupić podczas umówionej wizyty w pracowni w Güímar na Teneryfie.  
**Przycisk:** Umów wizytę

**Zamówienia indywidualne:** Szukasz innego rozmiaru Fine Art Print lub obrazu malowanego na zamówienie? Napisz do mnie. Współpracuję również z architektami.

**Dostawa — wersja bez niepotwierdzonego terminu:** Fine Art Print powstaje po złożeniu zamówienia. Dostawa jest dostępna do krajów Unii Europejskiej i Wielkiej Brytanii. Koszt zobaczysz przed płatnością.  
To nie jest kompletna polityka dostawy; wymaga uzupełnienia zweryfikowanego terminu i warunków.

**Kontakt:** Napisz na ania@ciok.art, aby umówić wizytę w pracowni lub porozmawiać o zamówieniu.  
**Dane firmy:** Anna Ciok Studio · numer podatkowy: Y9608071L.  
**Adres pracowni, rejestracyjny i zwrotny:** San Pedro Abajo 12, 38500 Guimar, Tenerife, Hiszpania (Wyspy Kanaryjskie).

## 9. Kolejność dalszej pracy

1. Uzupełnić zweryfikowane terminy dostawy. Nazwa firmy, numer podatkowy, miejsce rejestracji, adres rejestracyjny i zwrotny, koszt zwykłego odesłania po stronie klienta oraz zakres karty są już potwierdzone przez użytkownika.
2. Zatwierdzić propozycję ekspozycji ceramiki i przykładowy ton tekstów.
3. Przygotować kompletny polski zestaw copy po stronach i komunikatach, ze wskazaniem źródła w tłumaczeniach, CMS albo kodzie. Dokumenty formalne oznaczać jako robocze do zatwierdzenia.
4. Użytkownik zatwierdza finalne teksty. Przygotować konkretne zmiany funkcjonalne konieczne dla zgodności: saldo karty, jej ograniczony zakres i sprzedaż ceramiki online tylko podczas aktywnego dropu.
5. Wdrożyć zatwierdzone teksty wraz z zależnościami. Sprawdzić formularze, etykiety, dane kontaktowe, maile, SEO, JSON-LD, feedy i opublikowany CMS. Etykieta „Sprzedane” nie zastępuje walidacji dostępności.
6. Na bazie polskiego źródła przygotować EN/ES/DE, pozostawiając oryginalne nazwy kolekcji i produktów.
7. Po każdej zatwierdzonej zmianie aktualizować ten dokument i jego kopię w Notion w tym samym etapie pracy; rozbieżności rozstrzyga najnowsza jawna decyzja użytkownika.

## 10. Status tej sesji

- Utrwalono decyzje i przygotowano propozycje do oceny.
- Uzupełniono dane firmy Anna Ciok Studio, numer podatkowy Y9608071L, rejestrację w Hiszpanii na Wyspach Kanaryjskich oraz potwierdzenie wspólnego adresu pracowni, rejestracyjnego i zwrotnego.
- Sprawdzono nazwy na publicznej stronie, reguły fulfillmentu oraz jedną aktualną wycenę wysyłki.
- Lokalnie poprawiono centralny kontakt na `ania@ciok.art` oraz dosłowne adresy i błędny handle Instagrama w czterech plikach językowych. To aktualizacja danych kontaktowych, nie tłumaczenie całego nowego copy.
- Facebook zapisano jako oficjalny profil do uwzględnienia we wdrożeniu.
- Nie wdrożono nowego copy całej strony, salda karty ani nowej prezentacji ceramiki. Nie opublikowano zmian na produkcji.
- Słownik w Notion nie jest bazą tłumaczeń. Przy późniejszej synchronizacji `i18n:pull/push` trzeba uzgodnić zmienione dane kontaktowe z odpowiednimi wierszami, zgodnie z `docs/notion-i18n.md`.

## 11. Plan wdrożenia z 9 września — późniejsze decyzje

Źródło: [plan przekazany do realizacji](plans/2026-09-09-studio-copy-sales-model.md). Poniższe reguły zostały przyjęte w planie użytkownika; nie oznacza to zatwierdzenia każdego nowego zdania ani uruchomienia funkcji.

- `/sklep` przejmuje obecną kolekcję Fine Art Print. `/fine-art-prints` przekierowuje 308, również dla EN/ES/DE, z parametrami kampanii i działającymi kotwicami. Adresy produktów pozostają. Jedna pozycja sklepu w menu; ceramika pod `/showroom`.
- Publiczna ceramika trafia do wspólnej galerii niezależnie od flagi `showroom`. Status „Sprzedane” wymaga rzeczywistej sprzedaży. Podczas aktywnego dropu oferta online jest wyodrębniona; zakończenie dropu blokuje nowe rezerwacje również przez linki prywatne, zachowując obsługę płatności w toku. Odczyt dostępności ma blokować sprzedaż w razie błędu.
- Karta z saldem: PLN/EUR/GBP bez przewalutowania; pokrywa produkty i dostawę, zachowuje resztę, nie wygasa. Jedna karta na zamówienie, bez łączenia z rabatem. Dotychczasowe nominały i e-mail do kupującego pozostają.
- Saldo wymaga atomowych rezerwacji, idempotencji, pełnego opłacenia bez Stripe oraz dopłaty respektującej minimum operatora. Pełne i częściowe zwroty uwzględniają proporcje źródeł zapłaty. Migracja musi zachować prawa istniejących kart; nie wolno przywrócić kodów zużytych lub unieważnionych.
- Dotychczasowe ceny detaliczne dostawy pozostają. Różnica względem realizacji jest kosztem studia. Brak obietnicy śledzenia każdej przesyłki oraz niepotwierdzonych terminów.
- Nowe zwroty kierują do pracowni i kontaktu e-mail; nie generują nowych etykiet InPost. Dotychczasowe zwroty zachowują historię. Zwykłe odstąpienie, reklamacja i zakup zawarty w pracowni mają odrębne zasady.
- Zapis rozmiarów: centymetry, bez A3+/B2/B1; format wydruku, pole obrazu i rozmiar zewnętrzny oprawy muszą być rozróżnione.

## 12. Pakiet PL do akceptacji i porównanie CMS

[Podgląd PL](copy/2026-09-09/preview.html) i [rejestr tekstów](copy/2026-09-09/register-pl.json) obejmują istniejące klucze językowe, opisy wzorów, dodatkowe stany płatności, e-maile i propozycje CMS. Każdy wpis zawiera źródło techniczne, miejsce użycia, zależność publikacji i status **pending / do akceptacji**. Stare pola formularza zainteresowania, zwrotów i przycisków pustego koszyka są oznaczone do wycofania razem z dawnym UI; nie należy ich reaktywować tylko dlatego, że zachowano zgodność kluczy.

Odczyt CMS z tej sesji potwierdził 7 opublikowanych dokumentów. Do redakcji przygotowano PL: `page:home` (wersja 7), `page:print-pdp` (wersja 3), `product_notes:fine-art-prints` (wersja 4). [Propozycje CMS](copy/2026-09-09/cms-proposals-pl.json) zachowują media hero, identyfikatory i numery wersji bazowych oraz sumy kontrolne treści. Przed zapisaniem ponowić odczyt i sprawdzić brak nowszych zmian. Odczyt nie opublikował żadnego dokumentu.

Warunki nadal otwarte: akceptacja nowego PL, potwierdzenie macierzy terminów i terytoriów dostawy, uzupełnienie dokumentów formalnych oraz wykonanie etapów funkcjonalnych i publikacyjnych planu. Sprawdzanie polityki prywatności wymaga również zweryfikowania rzeczywistych odbiorców, umów, transferów i retencji. Nie utożsamiać tego pakietu z ukończeniem wdrożenia całego serwisu.
