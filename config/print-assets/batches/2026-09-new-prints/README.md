# Nowe printy — partia wrzesień 2026

Status: 16 produktów utworzonych w Supabase jako drafty; nie są opublikowane w sklepie.

- 16 designów: `fap042`–`fap057`, źródła `print-042`–`print-057`.
- 8 kolekcji opartych na nazwach serii; oryginalna numeracja prac pozostaje bez zmian.
- Wszystkie trzy proporcje są przygotowane w ignorowanym przez Git `design/uploads/master-images-prints/`.
- ID sprawdzono w Supabase i R2 29 września 2026. Przed importem ponownie sprawdzić konflikty; zapis lokalny nie rezerwuje ID w bazie.

Import wykonano po ponownym sprawdzeniu konfliktów: raport `nowe-printy-2026-import.json` potwierdza 16 draftów, 192 aktywne warianty i brak zmian wcześniejszych wierszy katalogu. Seed partii pozostaje oddzielony od publicznego fallbacku do czasu przygotowania treści i mediów. Nazwy zachowano w `seo_title`; kolekcje i oryginalna numeracja nazw wymagają podłączenia do publicznego katalogu przed aktywacją.

Lokalny podgląd payloadu: `node --import tsx scripts/stage-new-prints-2026.ts`. Import jest zakończony — nie ponawiać go; skrypt blokuje istniejący raport i konflikty ID. Pliki źródłowe oraz pochodne mają lokalne kopie w ignorowanym przez Git `design/`. Po zatwierdzeniu proofów wysłano 48 plików pochodnych do R2, zweryfikowano je i przypisano do 192 wariantów. Wszystkie 16 produktów pozostaje draftami. Raport zdalnej kontroli: `nowe-printy-2026-r2-publikacja.json`; raport przygotowania wraz z akceptacją: `nowe-printy-2026-przygotowanie.json`.

Pliki JSON są dokumentacją wejściową partii. Nie są gotowymi payloadami API CMS, manifestem `print-assets:onboard` ani konfiguracjami `prepare`. Nie są automatycznie ładowane przez sklep.

Punkt 4 wykonany: `nowe-printy-2026-plan-plikow.json` zapisuje kontrolę 48 źródeł (wymiary, profil sRGB, 300 DPI, SHA-256, zgodność kopii) i plan trzech profili dla 12 wariantów każdego produktu. Obejrzano istniejące podglądy 3:4 i 5:7. To plan lokalny, nie manifest gotowych plików do uploadu; rzeczywiste profile należy ponownie wyliczyć z aktywnych wariantów w bazie podczas `prepare`.

Gotowe konfiguracje `prepare` znajdują się osobno: `config/print-assets/fap042.json`–`fap057.json`. Stosują istniejącą konwencję `fullBleed` z trzema przygotowanymi źródłami. Wymagane przez schemat pole `2x3` wskazuje celowo nieistniejący `NO_MOUNT_SOURCE_2026-09.jpg`, tak jak w starszych konfiguracjach: passe-partout jest wyłączone. Jego włączenie wymaga przygotowania osobnego źródła; brak pliku zatrzyma pipeline zamiast użyć niewłaściwej grafiki.

`nowe-printy-2026-mapowanie.json` zachowuje hashe źródeł i mapowanie. `sourceFile` jest ścieżką względem zewnętrznego katalogu Prints. Raport rozmiarów wskazuje ścieżki względem repozytorium. Duże pliki wymagają osobnego backupu; nie są zawarte w tym commicie.

Pełny proces: [nowe printy - intro](../../../../docs/nowe-printy-intro.md).

Punkty 7–8 zakończone: 48 dostarczonych scen zweryfikowano i skonwertowano; z hero i ramami jest 448 plików WebP. `nowe-printy-2026-editorial.json` dokumentuje źródła i wyniki konwersji. `nowe-printy-2026-opisy.json` zawiera 64 teksty; `nowe-printy-2026-tresci-publikacja.json` potwierdza zapis 16 głównych mediów, publikację 8 kolekcji oraz czterech wersji notatek CMS i kontrolę aktualnych cen. Oryginalne numery prac są podłączone do nazw, a nowy rejestr fallback zawiera jawne drafty. Podgląd: `design/print-assets/2026-09-new-prints-review/galerie-i-opisy.html`. Wszystkie produkty nadal są draftami. Kolejnym krokiem jest commit i deploy kodu/obrazów, a następnie osobna, kontrolowana aktywacja.
