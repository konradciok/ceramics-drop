# Wdrożenie spójnego copy i modelu sprzedaży Anna Ciok Studio

## 1. Docelowy efekt i adresy stron

Strona prowadzi przede wszystkim do zakupu Fine Art Print. Ceramika przedstawia wcześniejsze prace, zaprasza do pracowni i umożliwia sprzedaż internetową podczas aktywnego dropu. Treści, dostępność produktów i obsługa płatności przekazują te same informacje.

| Miejsce | Docelowe działanie |
|---|---|
| `/sklep` | Obecna kolekcja Fine Art Print, z zachowanymi kolekcjami, kolejnością i konfiguratorami. |
| `/fine-art-prints` | Stałe przekierowanie 308 do `/sklep`, również dla EN/ES/DE. |
| `/fine-art-prints/[id]` | Dotychczasowe adresy produktów pozostają; odnośnik do kolekcji prowadzi do `/sklep`. |
| `/showroom` | Połączona prezentacja ceramiki z dotychczasowego sklepu i showroomu; etykieta „Ceramika” w menu. |
| Kategorie i strony ceramicznych produktów | Adresy pozostają, ale prezentacja i możliwość zakupu zależą od dostępności oraz aktywnego dropu. |
| `/zwrot` | Instrukcja zwrotu i kontakt e-mail z artystką. |

Usunąć podwójne pozycje prowadzące do kolekcji printów. Główne CTA, odnośniki do poszczególnych kolekcji i powroty do zakupów kierować bezpośrednio do `/sklep`. Zachować parametry kampanii i działanie kotwic kolekcji przy przekierowaniu.

## 2. Treści i wspólne źródła informacji

**Słownik i rejestr tekstów**

Rozszerzyć [źródło prawdy w projekcie](E:/repositories/ceramics-drop/docs/copy-source-of-truth.md) oraz jego [kopię w Notion](https://app.notion.com/p/3d61bd1a6c8f8195a89cf4e86da6180d) o wszystkie późniejsze decyzje. Dla każdego obszaru zapisać proponowane polskie copy, miejsce użycia, źródło techniczne i status Twojej akceptacji.

Przygotować cały polski zestaw: stronę główną, sklep, produkty, ceramikę, O studiu, Gallery, kontakt, ofertę indywidualną, kartę podarunkową, formularze, koszyk, płatności, konto, błędy, e-maile i dokumenty. Po akceptacji PL opracować EN/ES/DE.

**Zasady redakcyjne**

- Stosować **Anna Ciok Studio** jako markę i nazwę sprzedawcy; **Anna Ciok** jako imię i nazwisko artystki.
- Zachować dokładne **Fine Art Print**, oryginalne nazwy kolekcji oraz numerację produktów wewnątrz kolekcji, również „Ciala” i „Verticles”.
- Wyjaśniać produkt jako reprodukcję obrazu wykonanego akwarelą i tuszem. Dopuszczać „edycję otwartą”.
- Usunąć wzmianki o podpisywaniu, numerowanych egzemplarzach, certyfikatach i nazwie wykonawcy druku. Nie przypisywać Annie osobistego drukowania ani wysyłania printów z pracowni.
- Używać „Sprzedane” wyłącznie przy potwierdzonej sprzedaży. Usunąć nieaktualne zapowiedzi czerwcowego dropu i niepotwierdzone obietnice terminów.
- Podawać rozmiary w centymetrach, bez A3+/B2/B1; rozróżniać format wydruku, pole obrazu i zewnętrzne wymiary oprawy.
- Przedstawić obrazy na zamówienie, niestandardowe rozmiary i współpracę z architektami poprzez konkretne CTA e-mail. Usunąć niepotwierdzoną ofertę hurtową.

**Dane firmy i publikacja**

Współdzielić dane marki, kontaktu i sprzedawcy między interfejsem, dokumentami, e-mailami i SEO:

- Anna Ciok Studio; numer podatkowy **Y9608071L**.
- Adres pracowni, rejestracyjny i zwrotny: **San Pedro Abajo 12, 38500 Guimar, Tenerife, Hiszpania — Wyspy Kanaryjskie**.
- **ania@ciok.art** oraz wskazane przez Ciebie profile Instagram i Facebook.

Zmienić także tekstowy znak „CERAMICS” na „STUDIO”, podpisy nadawcy i etykiety dostępności. Zachować istniejącą konfigurację techniczną nadawania poczty.

Objąć zmianami zarówno pliki tłumaczeń, jak i opublikowane dokumenty CMS: stronę główną, informacje na kartach printów oraz opisy produktów. Synchronizować tylko uzgodnione zmiany, z porównaniem aktualnego stanu Notion i CMS.

## 3. Zmiany funkcjonalne

**Ceramika i dropy**

- Zbudować wspólną listę publicznej ceramiki, niezależną od samej flagi `showroom`. Usunąć przyczynę rozbieżności między dawnym sklepem a showroomem, bez oznaczania całej galerii jako sprzedanej.
- Poza dropem pokazywać galerię wcześniejszych prac i „Umów wizytę”. Nie prezentować jej jako aktualnego stanu pracowni ani oferować zakupu zdalnego lub wykonania podobnego przedmiotu.
- Podczas aktywnego dropu wyświetlać w `/showroom` wyodrębnioną ofertę dostępną online. Pozostałe przedmioty pozostają w galerii.
- Egzekwować aktywny drop, publiczny status produktu i dostępność w kafelkach, produktach, koszyku, API checkoutu oraz atomowej rezerwacji w bazie. Objąć regułą również nowe zakupy przez linki sprzedaży prywatnej.
- Zakończenie dropu blokuje nowe rezerwacje; wcześniej rozpoczęte płatności kończą się według istniejących zasad rezerwacji. Błąd odczytu dostępności nie może otwierać sprzedaży.
- Przy uruchomieniu zmian zakończyć dotychczasowy drop zgodnie z aktualnym modelem sprzedaży w pracowni. Zachować historię, identyfikatory i możliwość przyszłych dropów.

**Karta podarunkowa z saldem**

Zastąpić wydawanie jednorazowych kodów rabatowych osobnym mechanizmem kart: kwota początkowa, waluta, dostępne saldo, rezerwacje środków i historia operacji.

Przyjęte reguły:

- Nowa karta działa w walucie zakupu: PLN, EUR albo GBP, bez przewalutowania.
- Pokrywa produkty i dostawę; niewykorzystana część pozostaje na kolejne zakupy.
- Obejmuje standardowe Fine Art Print online oraz ceramikę podczas aktywnego dropu.
- Nie obejmuje wizyt w pracowni, zamówień indywidualnych ani zakupu następnej karty.
- Zachowujemy obecne nominały, dostarczenie kodu kupującemu e-mailem i brak terminu ważności.
- Domyślnie jedna karta na zamówienie, bez łączenia z kodem rabatowym. Koszyki printów i ceramiki nadal rozliczane osobno.

Saldo rezerwować i rozliczać transakcyjnie, z ochroną przed równoczesnym wykorzystaniem oraz powtórzonym żądaniem. Nie zwalniać rezerwacji środków, dopóki płatność może się jeszcze zakończyć sukcesem.

Rozszerzyć `/api/checkout` o pole `gift_card_code` i rozróżnienie odpowiedzi wymagającej płatności od zamówienia całkowicie opłaconego saldem. Przy pełnym pokryciu nie tworzyć PaymentIntent; potwierdzenie udostępniać przez bezpieczny mechanizm dostępu do zamówienia. Przy dopłacie zachować Stripe. Jeżeli dopłata byłaby niższa od dopuszczalnego minimum Stripe, odpowiednio zmniejszyć użycie karty i pozostawić różnicę na jej saldzie.

Wspólna, odporna na ponowienia obsługa opłaconego zamówienia musi uruchamiać realizację, potwierdzenia i dokumenty także bez płatności Stripe. Zapewnić odzyskanie procesu po awarii między opłaceniem a przekazaniem do realizacji.

Rozdzielić wartość zamówienia od kwoty zapłaconej kartą i dopłaty pieniężnej. Uwzględnić podział w koncie, e-mailach, panelu, dokumentach i raportowaniu. Pokazywać klientowi kwotę wykorzystaną oraz pozostałe saldo.

Zwroty pełne i częściowe rozliczać proporcjonalnie do pierwotnych źródeł płatności, bez podwójnego przywracania salda. Częściowy zwrot pieniędzy nie może automatycznie przywracać całej ceramiki do sprzedaży. Zwrot zakupu wykorzystanej karty wymaga obsługi przez studio; system nie może automatycznie oddać pełnej kwoty i pozostawić środków do dalszego użycia.

Przed przełączeniem sprawdzić istniejące kody i płatności w toku. Zachować prawa wcześniej wydanych kart i obsługę zwykłych promocji; nie reaktywować kodów wykorzystanych lub unieważnionych.

**Dostawa, zwroty i dokumenty**

- Zachować obecne detaliczne opłaty dostawy oraz obsługiwane waluty. Różnica względem kosztu realizacji pozostaje kosztem studia.
- Potwierdzić używaną usługę transportową, terminy dla oferowanych wariantów i kierunków oraz ograniczenia terytorialne. Przedział doręczenia musi obejmować produkcję i transport — dokumentacja rozróżnia te etapy. [Dokumentacja dostawy](https://www.prodigi.com/faq/shipping/)
- Utworzyć współdzielone reguły dostawy i zwrotów dla checkoutu, stron informacyjnych i danych strukturalnych. Nie obiecywać śledzenia każdej przesyłki.
- Zastąpić generowanie nowych etykiet InPost instrukcją odesłania do pracowni i kontaktem na ania@ciok.art. Zachować historię już utworzonych zwrotów. E-mail ma ułatwiać obsługę, bez wymagania założenia konta.
- Rozdzielić zwykłe odstąpienie, reklamację oraz zakup w pracowni. Koszt zwykłego odesłania ponosi klient.
- Przygotować do Twojego zatwierdzenia regulamin, politykę prywatności, dostawy, zwrotów i karty. Zweryfikować je dla sprzedawcy z Hiszpanii oraz obsługiwanych rynków; nie wyłączać automatycznie zwrotów standardowych printów tylko dlatego, że powstają po zamówieniu. [Hiszpańskie przepisy konsumenckie](https://www.boe.es/buscar/act.php?id=BOE-A-2007-20555)

## 4. Kolejność wdrożenia

1. **Utrwalenie ustaleń i kompletne PL.** Przygotować teksty oraz podglądy do Twojej akceptacji. Zweryfikowane terminy dostawy są warunkiem publikacji kompletnej polityki dostaw.
2. **Podstawy techniczne.** Przygotować wspólne dane firmy, reguły dostępności, rozszerzenia rozliczeń i migracje zgodne z istniejącymi zamówieniami.
3. **Adresy i ceramika.** Przenieść kolekcję printów do `/sklep`, scalić ceramikę w `/showroom`, zaktualizować nawigację, CMS i mechanizmy publikacji.
4. **Karty i zwroty.** Uruchomić rozliczanie salda wraz z odpowiadającymi mu treściami oraz nową instrukcją zwrotów.
5. **Języki i publikacja.** Po akceptacji PL przygotować EN/ES/DE. Zmiany wspólnych funkcji publikować wraz ze zgodnymi komunikatami we wszystkich czterech językach.

Aktualizować Notion i dokumentację projektu w tych samych etapach. Zachować istniejące lokalne poprawki kontaktu.

Wycofanie funkcji kart powinno zatrzymywać nowe transakcje z ich użyciem, zachowując saldo i historię. Nie wolno wracać do mechanizmu jednorazowego kodu dla kart już wydanych z saldem.

## 5. Weryfikacja i warunki zakończenia

- **Routing:** `/sklep` pokazuje printy; stare adresy kolekcji przekierowują we wszystkich językach; produkty zachowują adresy i prawidłowe 404. Sprawdzić kotwice, canonical, hreflang, sitemapę i podglądy CMS.
- **Ceramika:** przetestować brak dropu, aktywny i zakończony drop, produkt sprzedany, rezerwację, stary koszyk, bezpośrednie żądanie API oraz awarię odczytu dostępności.
- **Karty:** zakup, ponowna wysyłka kodu, częściowe i pełne pokrycie zamówienia, ponowne użycie salda, błędna waluta, wykluczony produkt, równoczesne zakupy, anulowanie, ponowienia webhooków oraz zwroty.
- **Treści:** przejrzeć wynikowy HTML, wszystkie opisy printów, e-maile i stany błędów. Sprawdzić nazwę marki, dane firmy, profile społecznościowe, jednostki i brak niepotwierdzonych obietnic.
- **SEO i feedy:** zgodność nazw, cen, walut, dostępności, kierunków dostawy i zwrotów z rzeczywistą ofertą. Ceramiczne archiwum nie może być reklamowane jako dostępna oferta internetowa.
- **Kontrole projektu:** lint, typecheck, testy jednostkowe i integracyjne płatności, odpowiednie E2E oraz build Next.js i OpenNext z zachowaniem wymogu webpack.

Wdrożenie jest zakończone po Twojej akceptacji treści, przejściu kontroli i sprawdzeniu opublikowanego serwisu — łącznie z CMS, pocztą, dokumentami i danymi dla wyszukiwarek.
