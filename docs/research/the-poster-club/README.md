# The Poster Club — research hub

Cel: zrozumieć jak główny konkurent buduje discovery, merchandising i PDP-y dla premium art marketplace, a potem przełożyć to na konkretne ruchy dla `ceramics-drop`.

## Co tu jest

### 00. Strategic summary
- [`00-executive-summary.md`](./00-executive-summary.md)
- Najkrótsza wersja: co robią dobrze, co warto skopiować, czego nie kopiować 1:1.

### 01. Information architecture / marketplace map
- [`01-marketplace-map.md`](./01-marketplace-map.md)
- Nawigacja, typy kolekcji, zakres katalogu, merchandising layers.

### 02. Collections + PLP anatomy
- [`02-collections-and-plp.md`](./02-collections-and-plp.md)
- Struktura collection page, filtry, karty produktów, density controls, statystyki katalogu.

### 03. PDP anatomy
- [`03-pdp-anatomy.md`](./03-pdp-anatomy.md)
- Print vs canvas vs wall object. Information hierarchy, trust, upsell, editorial content.

### 04. Opportunities for ceramics-drop
- [`04-ceramics-drop-opportunities.md`](./04-ceramics-drop-opportunities.md)
- Priorytety wdrożeń z mapowaniem do aktualnych plików repo.

## Raw evidence

Wszystkie dane źródłowe siedzą w [`raw/`](./raw):

- [`poster-club-research.json`](./raw/poster-club-research.json) — pełny dump research payload
- [`poster-club-sitemap.json`](./raw/poster-club-sitemap.json) — sitemap index + 101 collection URLs
- [`poster-club-collections.json`](./raw/poster-club-collections.json) — statystyki 7 kluczowych kolekcji
- [`poster-club-sample-pdps.json`](./raw/poster-club-sample-pdps.json) — 3 sample PDP-y: print / canvas / wall object
- [`browser-observations.json`](./raw/browser-observations.json) — ręczne obserwacje UX z live browse

## Repro

Skrypt do odświeżenia datasetu:

```bash
node scripts/research/scrape-the-poster-club.mjs
```

Output ląduje domyślnie w:

```bash
docs/research/the-poster-club/raw
```

## Repo baseline used for comparison

Porównania do `ceramics-drop` opierają się głównie na tych plikach:

- `src/components/shop/PrintCollectionScreen.tsx`
- `src/components/shop/PrintProductScreen.tsx`
- `src/components/shop/PrintConfigurator.tsx`
- `src/components/shop/ProductPageScreen.tsx`
- `src/components/shop/ProductTile.tsx`

## Quick take

The Poster Club nie wygrywa samą estetyką. Wygrywa tym, że:
1. robi bardzo mocny **discovery layer**,
2. utrzymuje **premium cues** na każdym poziomie,
3. zamienia PDP w **merchandising surface**, a nie tylko kartę produktu,
4. prowadzi użytkownika od kategorii → artysty → produktu → related works bez tarcia.
