# Nowe printy — partia wrzesień 2026

Status: przygotowane lokalnie; produkty nie zostały utworzone ani opublikowane.

- 16 designów: `fap042`–`fap057`, źródła `print-042`–`print-057`.
- 8 kolekcji opartych na nazwach serii; oryginalna numeracja prac pozostaje bez zmian.
- Wszystkie trzy proporcje są przygotowane w ignorowanym przez Git `design/uploads/master-images-prints/`.
- ID sprawdzono w Supabase i R2 29 września 2026. Przed importem ponownie sprawdzić konflikty; zapis lokalny nie rezerwuje ID w bazie.

Pliki JSON są dokumentacją wejściową partii. Nie są gotowymi payloadami API CMS, manifestem `print-assets:onboard` ani konfiguracjami `prepare`. Nie są automatycznie ładowane przez sklep.

Punkt 4 wykonany: `nowe-printy-2026-plan-plikow.json` zapisuje kontrolę 48 źródeł (wymiary, profil sRGB, 300 DPI, SHA-256, zgodność kopii) i plan trzech profili dla 12 wariantów każdego produktu. Obejrzano istniejące podglądy 3:4 i 5:7. To plan lokalny, nie manifest gotowych plików do uploadu; rzeczywiste profile należy ponownie wyliczyć z aktywnych wariantów w bazie podczas `prepare`.

Gotowe konfiguracje `prepare` znajdują się osobno: `config/print-assets/fap042.json`–`fap057.json`. Stosują istniejącą konwencję `fullBleed` z trzema przygotowanymi źródłami. Wymagane przez schemat pole `2x3` wskazuje celowo nieistniejący `NO_MOUNT_SOURCE_2026-09.jpg`, tak jak w starszych konfiguracjach: passe-partout jest wyłączone. Jego włączenie wymaga przygotowania osobnego źródła; brak pliku zatrzyma pipeline zamiast użyć niewłaściwej grafiki.

`nowe-printy-2026-mapowanie.json` zachowuje hashe źródeł i mapowanie. `sourceFile` jest ścieżką względem zewnętrznego katalogu Prints. Raport rozmiarów wskazuje ścieżki względem repozytorium. Duże pliki wymagają osobnego backupu; nie są zawarte w tym commicie.

Pełny proces: [nowe printy - intro](../../../../docs/nowe-printy-intro.md).
