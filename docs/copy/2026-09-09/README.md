# Polski zestaw do akceptacji — Anna Ciok Studio

Status: **PL zaakceptowane przez użytkownika 9 września 2026; wdrożenie i publikacja w toku**. Zapis akceptacji: [approval.json](approval.json). Podstawa: plan użytkownika z 9 września 2026 i [słownik](../../copy-source-of-truth.md). Historyczne statusy w podglądzie opisują chwilę przygotowania pakietu; aktualny status określa zapis akceptacji.

Ten pakiet realizuje etap „Utrwalenie ustaleń i kompletne PL”. Zatwierdzenie zasad biznesowych w planie nie oznacza zatwierdzenia poniższych nowych zdań. Pozostałe etapy planu pozostają do wdrożenia; samo copy nie włącza salda ani nie zamyka sprzedaży ceramiki.

[Pakiet w Notion](https://app.notion.com/p/3d61bd1a6c8f81fb8119d120823b2328) zawiera natywne podstrony z tym samym zestawem PL, źródłami i statusem do akceptacji.

- [Podgląd](preview.html) — wszystkie teksty, wyszukiwanie, źródła i zależności publikacji.
- [PL JSON](pl.json) — pełna propozycja pliku językowego; zachowuje istniejące klucze, indeksy opisów i składnię ICU.
- [Dodatkowe komunikaty](additional-pl.json) — nowe stany dropu, karty, rozliczeń, e-maile i dane firmy.
- [Dokumenty](documents-pl.md) — regulamin, prywatność, dostawa, zwroty i karta; wersja robocza do zatwierdzenia.
- [Porównanie źródeł](sources.json) — sumy kontrolne lokalnego wejścia oraz status odczytu CMS. Przed publikacją ponowić odczyt i porównać wersje; nie nadpisywać nowszej redakcji.
- [Opis realizacji](../../audits/2026-09-09-copy-implementation.md) — wykonane kroki i pozostałe warunki.

`node docs/copy/2026-09-09/build-preview.mjs` odtwarza podgląd i rejestr z gotowych JSON-ów. Nie modyfikuje sklepu, CMS ani bazy tłumaczeń Notion. Status „do akceptacji” obejmuje każdy wpis, także pozostawiony bez zmian. Zapisane w podglądzie źródła są mapą wdrożenia, nie deklaracją publikacji.

Przed publikacją pozostają: weryfikacja terminu produkcja + transport i terytoriów szczególnych, rozliczenia salda, atomowa kontrola dropu oraz weryfikacja dokumentów formalnych. Akceptacja PL pozwala przygotować EN/ES/DE i wdrażać zgodne komunikaty razem z funkcjami. Nie należy kopiować tego JSON-u bezpośrednio na produkcję przed spełnieniem tych zależności.
