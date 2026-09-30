# Nowy układ kolekcji — 2026-09

Źródłem układu jest arkusz właściciela `aktywne_printy_storefront` z 56 aktywnymi printami.

- 12 aktywnych kolekcji;
- kolejność kolekcji i printów jest zapisana w `config/print-catalog-curation.json`;
- nazwy printów mogą pozostać niezależne od kolekcji dzięki polu `displayName`;
- dawne kolekcje Cumulonimbus, Cumulus, Scopulus, Unda i Tachylite pozostają w historii CMS, ale synchronizacja czyści ich członkostwo;
- `fap058` zmienia nazwę sklepową z `Cirrus 05` na `Cumulus 02`.

Publikacja nazwy i treści: `node --import tsx scripts/rename-fap058-cumulus-02.ts` (dry-run), następnie `--apply` po wdrożeniu kodu.
