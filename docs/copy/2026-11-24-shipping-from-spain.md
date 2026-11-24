# Copy do akceptacji — wysyłka z Hiszpanii (24 listopada 2026)

Status: **zatwierdzone przez właściciela 24 listopada 2026 bez zmian.** Wdrożone razem z tłumaczeniami EN/ES/DE w `messages/*.json`, w e-mailach (`src/lib/email.ts`, kopia w `scripts/reconcile-orders.mjs`) i w danych strukturalnych. Zaktualizowany jest też §13 w `docs/copy-source-of-truth.md`.

Etap A obejmuje to, co działa od dziś:
- ceramika jest w Hiszpanii;
- sklep wysyła **tylko do Paczkomatów InPost w Polsce**, bez kuriera i bez odbioru osobistego;
- etykiety są na razie nadawane ręcznie przez inpost.es, więc numer przesyłki wysyła się ręcznie.

Etap B (pozostałe kraje przez Sendcloud) dopiszemy, gdy ruszy PR 4.

Zasady z `docs/copy-source-of-truth.md`:
- w opowieści artystki pierwsza osoba („wysyłam”, „pakuję”);
- informacje o zamówieniu podajemy neutralnie („zamówienie jest realizowane”, „otrzymasz e-mailem”).

## Decyzje do potwierdzenia przed tekstami

1. **Czas dostawy do Polski: „do 7 dni roboczych”.** InPost España podaje 5–7 dni dla Polski, warunki B2B 4 dni. Do tego dochodzi realizacja do 2 dni roboczych, bez zmian.
2. **Czy piszemy wprost, że ceramika wychodzi z Hiszpanii?** Proponuję tak. Tłumaczy dłuższy czas, a ceł nie ma, bo to UE.
3. **Okno odbioru 48 godzin.** Przy przesyłkach z Hiszpanii paczka czeka w polskim paczkomacie 48 h. Później trafia do centrum InPost na 10 dni. Proponuję jedną linijkę na stronie dostawy.
4. **Cena paczkomatu jest stała za zamówienie.** Proponuję usunąć „od” sprzed ceny.

## Teksty PL

| Klucz | Gdzie | Teraz | Propozycja |
|---|---|---|---|
| `ship.paczkomatD` | koszyk, opis opcji | Odbiór w wybranym paczkomacie, dostawa do 5 dni roboczych. | Odbiór w wybranym paczkomacie, dostawa do 7 dni roboczych. |
| `ship.paczkomatPrice` | koszyk, cena opcji | od {price} | {price} |
| `delivery.plOnly` | koszyk, nad danymi dostawy | Ceramika wysyłana jest tylko na adresy w Polsce. | Ceramika wysyłana jest tylko do Paczkomatów InPost w Polsce. |
| `deliveryNotice.p1` | koszyk, ramka „Informacja o dostawie” | Wszystkie zamówienia na terenie Polski będą wysyłane za pośrednictwem InPost — kurierem lub do Paczkomatów. | Zamówienia są wysyłane z Hiszpanii do Paczkomatów InPost w całej Polsce. |
| `deliveryNotice.p2` | j.w. | Zamówienie jest realizowane do 2 dni roboczych, dostawa do 5 dni roboczych. | Zamówienie jest realizowane do 2 dni roboczych, dostawa do 7 dni roboczych. |
| `deliveryNotice.p3` | j.w. | Numer śledzenia InPost wyślemy e-mailem po nadaniu przesyłki. | Numer przesyłki otrzymasz e-mailem po nadaniu paczki. |
| `home.craft3PShipOnly` | strona główna, blok „Dostawa w całej Polsce” | Paczkomat albo kurier InPost w Polsce, z dostawą do 5 dni roboczych. | Paczkomat InPost w całej Polsce, z dostawą do 7 dni roboczych. |
| `home.ctVShip` | strona główna, pasek faktów | Polska · InPost, dostawa do 5 dni roboczych | Polska · Paczkomat InPost, dostawa do 7 dni roboczych |
| `studio.fact4D` | O studiu, fakty | Zamówienie jest realizowane do 2 dni roboczych, a dostawa w Polsce trwa do 5 dni roboczych. Ceramikę pakuję i nadaję sama. | Zamówienie jest realizowane do 2 dni roboczych, a dostawa do paczkomatu w Polsce trwa do 7 dni roboczych. Ceramikę pakuję i nadaję sama. |
| `contact.vShip` | Kontakt, „Wysyłka” | Realizacja do 2 dni roboczych, dostawa do 5 dni roboczych | Realizacja do 2 dni roboczych, dostawa do 7 dni roboczych |
| `shipping.s1P` | Dostawa i zwroty, „Wysyłka” | Prace wysyłam **Paczkomatem InPost (od {locker})** albo **kurierem InPost ({courier})** na terenie całej Polski. Koszt nie zależy od liczby zamówionych prac — jeśli wybierzesz kilka, spakuję je razem. | Prace wysyłam z Hiszpanii **do Paczkomatów InPost ({locker})** na terenie całej Polski. Koszt nie zależy od liczby zamówionych prac — jeśli wybierzesz kilka, spakuję je razem. |
| `shipping.s1Li1` | j.w., lista | Paczkomat InPost, cała Polska — od {locker} | Paczkomat InPost, cała Polska — {locker} |
| `shipping.s1Li4` *(nowy)* | j.w., lista | — | Paczka czeka w paczkomacie 48 godzin od powiadomienia InPost. |
| `shipping.s1Li3` | j.w., lista | Wysyłka zagraniczna — napisz do mnie, wycenię ją indywidualnie | *bez zmian do etapu B* |
| `shipping.s2P` | Dostawa i zwroty, „Czas realizacji” | Ceramika jest gotowa i czeka w Polsce, więc nie ma tu czasu produkcji. Zamówienie jest realizowane do **2 dni roboczych** od zaksięgowania płatności, a dostawa trwa do **5 dni roboczych**. | Ceramika jest gotowa i czeka w Hiszpanii, więc nie ma tu czasu produkcji. Zamówienie jest realizowane do **2 dni roboczych** od zaksięgowania płatności, a dostawa do paczkomatu trwa do **7 dni roboczych**. |
| `terms.s4P` | Regulamin §4 *(tekst prawny)* | Zamówienie jest realizowane do 2 dni roboczych od zaksięgowania płatności, dostawa do 5 dni roboczych na terenie Europy. Szczegóły kosztów i terminów znajdziesz na stronie Dostawa i zwroty. | Zamówienie jest realizowane do 2 dni roboczych od zaksięgowania płatności, a dostawa do Paczkomatu InPost w Polsce trwa do 7 dni roboczych. Szczegóły kosztów i terminów znajdziesz na stronie Dostawa i zwroty. |

Bez zmian, bo nadal prawdziwe:
- `home.craft3HShipOnly` („Dostawa w całej Polsce”)
- `home.craft2P`
- `ceramicShop.metaDescription` („wysyłka InPost w Polsce”)
- `account.*`

## E-mail z potwierdzeniem zamówienia

Zmiana obejmuje `deliveryP1`–`deliveryP3` w `src/lib/email.ts` oraz ich kopię w `scripts/reconcile-orders.mjs`. Treść jest taka sama jak `deliveryNotice.p1`–`p3` powyżej.

## Dane strukturalne (Google)

To nie jest copy, ale też do zatwierdzenia:
- `shippingDetails` deklaruje dziś wysyłkę do ES, DE i GB, zależnie od języka strony. To nieprawda. Będzie tylko **PL** we wszystkich językach.
- Czas transportu zmienia się z 1–5 na **1–7 dni**.
