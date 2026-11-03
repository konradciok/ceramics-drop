# Nowy układ kolekcji — 2026-09

Źródłem układu jest arkusz właściciela `aktywne_printy_storefront` z 56 aktywnymi printami.

- 12 aktywnych kolekcji;
- kolejność kolekcji i printów jest zapisana w `config/print-catalog-curation.json`;
- nazwy printów mogą pozostać niezależne od kolekcji dzięki polu `displayName`;
- dawne kolekcje Cumulonimbus, Cumulus, Scopulus, Unda i Tachylite pozostają w historii CMS, ale synchronizacja czyści ich członkostwo;
- `fap058` zmienia nazwę sklepową z `Cirrus 05` na `Cumulus 02`.

Publikacja nazwy i treści: `node --import tsx scripts/rename-fap058-cumulus-02.ts` (dry-run), następnie `--apply` po wdrożeniu kodu.

## Publikacja

Układ został opublikowany 2026-09-30:

- katalog produkcyjny zsynchronizowany;
- 12 aktywnych kolekcji odpowiada arkuszowi, a pięć dawnych grup ma puste członkostwo;
- wszystkie 48 zatwierdzonych opisów aktywnych kolekcji jest opublikowane;
- `fap058` ma nazwę `Cumulus 02` w PDP, metadanych obrazu i czterech wersjach językowych;
- wynik operacji i kontroli zapisano w `kolekcje-publikacja.json` oraz `cumulus-02-publikacja.json`.
