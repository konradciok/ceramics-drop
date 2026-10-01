# Opisy kolekcji Fine Art Print — zatwierdzone (PL / EN / ES / DE)

Status: **zatwierdzone 30 września 2026 przez użytkownika** (zasada z [copy-source-of-truth.md](../../copy-source-of-truth.md)), **jeszcze nie zaimportowane do CMS** — import uruchamia człowiek z poświadczeniami produkcyjnymi (sekcja 5). Przygotowane po obejrzeniu wszystkich 56 prac.

- **Aktualizacja po zmianie układu kolekcji (1 października):** [aktualizacja-ukladu-kolekcji.md](aktualizacja-ukladu-kolekcji.md) — nowy tekst Cirrus oraz korekty Horizons i Portals, bo PR #342 zmienił skład tych kolekcji.
- [opisy-kolekcji.json](opisy-kolekcji.json) — te same teksty w formie maszynowej (`kolekcja → język → opis`); to wejście skryptu `npm run collections:import-descriptions` (odmawia pracy, dopóki `status` ≠ `approved`).
- Poniżej: podsumowanie, metoda, reguły i kontrola, decyzje, wdrożenie, a na końcu wszystkie 68 tekstów wraz z notatką „Co widać”, na której opiera się każdy opis.

## 1. Podsumowanie

Opis trafia do pola „Opis kolekcji” (osobno dla każdego języka). Strona kolekcji jest indeksowalna, gdy opis w danym języku ma co najmniej 80 znaków **i** kolekcja ma co najmniej 3 opublikowane prace; pierwsze zdanie opisu jest zajawką karty na `/kolekcje`.

| Kolekcja | Prace | Po publikacji indeksowana? | Słowa PL / EN / ES / DE |
|---|---|---|---|
| Ostrea | 5 | tak | 83 / 99 / 106 / 89 |
| Gestures | 8 | tak | 89 / 107 / 118 / 99 |
| Linea | 9 | tak | 84 / 88 / 107 / 80 |
| Horizons | 2 | nie — za mało prac (min. 3) | 76 / 89 / 99 / 88 |
| Portals | 5 | tak | 81 / 81 / 88 / 78 |
| Signs | 2 | nie — za mało prac (min. 3) | 79 / 92 / 93 / 80 |
| Ciala | 2 | nie — za mało prac (min. 3) | 83 / 96 / 112 / 88 |
| Balance | 2 | nie — za mało prac (min. 3) | 69 / 78 / 91 / 67 |
| Verticles | 4 | tak | 79 / 95 / 94 / 89 |
| Aurora | 3 | tak | 75 / 88 / 104 / 75 |
| Cirrus | 2 | nie — za mało prac (min. 3) | 69 / 79 / 90 / 70 |
| Cumulonimbus | 2 | nie — za mało prac (min. 3) | 71 / 78 / 88 / 71 |
| Cumulus | 2 | nie — za mało prac (min. 3) | 69 / 82 / 94 / 74 |
| Obsidian | 4 | tak | 82 / 102 / 115 / 96 |
| Scopulus | 1 | nie — za mało prac (min. 3) | 73 / 84 / 101 / 79 |
| Unda | 2 | nie — za mało prac (min. 3) | 74 / 90 / 96 / 80 |
| Tachylite | 1 | nie — za mało prac (min. 3) | 69 / 85 / 92 / 75 |

Kwalifikuje się 7 z 17 kolekcji. Pozostałe 10 dostaną opis widoczny dla odwiedzających i zajawkę na hubie, ale przy obecnym progu pozostaną `noindex`, dopóki nie przybędzie prac.

## 2. Jak powstały

1. **Analiza wizualna.** Kolekcja po kolekcji obejrzałem kontaktówki prac (obrazy 800 px, podpisane numerami `fapNNN`) i zapisałem, co faktycznie widać: paletę, formy, rodzaj kreski, akcenty, kompozycję. Ta notatka („Co widać”) stoi pod każdą kolekcją i jest jedyną podstawą faktów w opisie.
2. **Słownictwo.** Nazwy kolorów i technik (półprzejrzyste plamy, prążkowana wstęga, rdzawe drobiny, złoty akcent) pochodzą z istniejących opisów prac (`notes.fine-art-prints`), więc ton pasuje do kart produktów. Nie kopiowałem ich zdań.
3. **Reguły marki.** Teksty przeszły przez zasady z [copy-source-of-truth.md](../../copy-source-of-truth.md): „Fine Art Print” bez przemianowywania, spokojny konkretny język bez personifikacji, brak numeracji/limitowania/podpisywania, brak nazwy partnera druku, brak obietnic terminu dostawy, oryginalne nazwy kolekcji we wszystkich językach.
4. **Metoda (skille).** Użyłem opublikowanego przebiegu pracy trzech skilli: [Marketing → content-creation](https://github.com/anthropics/knowledge-work-plugins/tree/main/marketing) (lista kontrolna SEO: fraza główna w pierwszym zdaniu, meta poniżej 160 znaków, jedna fraza na tekst), [Brand Voice → brand-voice-enforcement](https://github.com/anthropics/knowledge-work-plugins/tree/main/partner-built/brand-voice) (zastosuj istniejące wytyczne, potem waliduj i wyjaśnij decyzje) oraz zainstalowanego skilla `searchfit-seo:content-translation` (lokalizacja pod frazy rynku, a nie tłumaczenie słowo w słowo). Dwa pierwsze nie są jeszcze włączone na koncie, więc korzystałem z ich publicznych definicji; karta instalacji została pokazana w rozmowie.
5. **Frazy rynkowe** sprawdzone w wynikach wyszukiwania: PL „abstrakcyjne obrazy akwarelowe”, „obraz do salonu/sypialni”; EN (UK) „abstract watercolour prints”, „wall art”; ES „láminas abstractas”, „cuadros abstractos”, „acuarela y tinta”; DE „abstrakte Kunstdrucke”, „Wandbild”, „Aquarell und Tusche”. W każdym tekście jest fraza kategorii („abstrakcyjne / abstract / abstractas / abstrakte”), technika („akwarela i tusz” w danym języku) i nazwa produktu „Fine Art Print”, która zostaje bez zmian w każdym języku; pozostałe frazy (pomieszczenia, materiały wnętrzarskie) pojawiają się tylko tam, gdzie pasują.

## 3. Reguły i automatyczna kontrola

Jednorazowy walidator sprawdził wszystkie 68 tekstów; wynik: **0 uwag**.

- długość co najmniej 80 znaków (próg indeksowalności w kodzie) i 60–135 słów;
- pierwsze zdanie ma najwyżej 140 znaków (tyle mieści karta huba bez ucinania) i zawiera nazwę kolekcji;
- w każdym tekście: fraza kategorii („abstrakcyjne / abstract…”) co najmniej raz, technika (akwarela + tusz w danym języku) i dokładnie jedno „Fine Art Print”; w PL bez „Fine Art Prints”;
- brak słów wykluczonych przez słownik lub niemożliwych do zweryfikowania: limitowany/numerowany/podpisany/certyfikat/unikat, Prodigi, terminy i koszty dostawy, waluty, rozmiary A3/B2/B1, miejscowości;
- brak liczb (liczba prac i rozmiary się zmieniają);
- żadne dwa opisy nie powtarzają zdań (nakładanie 5-gramów poniżej progu), a pierwsze zdania są unikalne.

## 4. Do decyzji i uwagi

1. **Weryfikacja przez człowieka.** Skill lokalizacyjny wprost odradza publikację tekstów bez przeglądu. PL czytałem jako redaktor; EN/ES/DE są pisane jako wersje docelowe, ale warto, by natywna osoba rzuciła okiem (szczególnie na ES i DE).
2. **Słowo „abstrakcyjne”.** Dodałem je celowo raz w każdym tekście, bo to główna fraza kategorii w wyszukiwarce we wszystkich czterech językach. W dotychczasowym copy marki go nie ma (opisy prac mówią o kompozycji, nie o abstrakcji), więc to decyzja do potwierdzenia. Jeśli Anna woli go unikać, wystarczy je usunąć — to jedno miejsce w tekście, kosztem nieco słabszego SEO.
3. **Co jest interpretacją.** Opisuję to, co widać. Nie zgaduję intencji Anny ani znaczeń nazw. Porównania („jak muszle”, „jak zasłony światła”, „jak dmuchawce”) są wizualne i wyraźnie tak sformułowane („przywodzą na myśl”, „kojarzą się z”). „Złoty akcent” nie deklaruje materiału. Jeśli któraś nazwa ma dla Anny konkretne znaczenie, warto je dopisać.
4. **Kolekcje 1–2-pracowe.** Opisy Horizons, Ciala, Unda mówią „w innej pracy…”, a Scopulus i Tachylite opisują pojedynczy obraz. Po dodaniu prac do takiej kolekcji tekst trzeba przejrzeć. Kolekcje z co najmniej 3 pracami (Ostrea, Gestures, Linea, Portals, Verticles, Aurora, Obsidian) są opisane ogólnie i wytrzymają dopisywanie prac.
5. **Bliskie kompozycje.** Ciala 01 (fap008) i Obsidian 05 (fap053) mają tę samą kompozycję z drobnymi różnicami (to dwa osobne obrazy), a Scopulus 02 (fap054) jest trzecim wariantem tego układu. W katalogu wycofano wcześniej fap029 i fap037 jako „near-duplicate composition”. Warto zdecydować, czy te pary traktować tak samo; opisy nie twierdzą, że praca jest jedyna w swoim rodzaju.
6. **Układ strony kolekcji** *(wdrożone razem z tą paczką)*. Cały opis był renderowany jako `lead` w kolumnie o szerokości 42 znaków (ok. 11 linii, nagłówek ok. 510 px). Teraz pierwsze zdanie jest `lead`, a reszta akapitem obok (na węższych ekranach pod spodem) — nagłówek ma ok. 285 px (`splitCollectionDescription` w `src/lib/print-collections.ts`).
7. **Meta description** *(wdrożone razem z tą paczką)*. Kod ucinał opis w 160. znaku, więc fragment w wynikach wyszukiwania urywał się w środku zdania. Teraz meta to tyle pełnych zdań, ile mieści się w 155 znakach (`collectionMetaDescription`); test pilnuje, że każdy z 68 tekstów daje pełne zdania bez wielokropka.
8. **Kwalifikacja do indeksu.** Tylko 7 kolekcji ma co najmniej 3 prace. Opisy pozostałych 10 poprawiają stronę dla odwiedzających, ale ich `noindex` zniknie dopiero po dopisaniu prac albo obniżeniu progu (decyzja produktowa; osobna).

## 5. Wdrożenie

Wybrana droga: **skrypt importu** (`scripts/import-collection-descriptions.ts`). Działa przez te same RPC co CMS (`save_collection_draft` → `publish_collection_revision`), więc każdy zapis ma wpis w `catalog_audit_log` (aktor `import-descriptions@ceramics-drop.internal`) i nową, niezmienną rewizję.

Zasady bezpieczeństwa skryptu:

- **Dry-run domyślnie** — bez `--confirm` tylko czyta CMS i wypisuje plan (co zostanie zapisane, pominięte lub zachowane).
- **Nie nadpisuje pracy redakcji.** Opis w danym języku jest zastępowany tylko wtedy, gdy w CMS jest pusty albo to zasiany placeholder („Ostrea.”). Cokolwiek napisanego ręcznie zostaje (`kept`), chyba że podasz `--force`.
- **Nie publikuje cudzych zmian.** Kolekcja z niepublikowanym szkicem innej osoby jest pomijana z komunikatem — inaczej publikacja wciągnęłaby i ten szkic. Szkic zapisany wcześniej przez sam skrypt (przerwany przebieg) jest publikowany przy następnym uruchomieniu — także gdy zachował tekst wpisany ręcznie w CMS — o ile publikacja może wprowadzić na produkcję wyłącznie zatwierdzone opisy (skrypt porównuje szkic z opublikowaną rewizją: każdy język to zatwierdzony tekst albo tekst, który już jest na stronie, i nic poza opisami się nie różni). W innym wypadku szkic jest pomijany z komunikatem.
- **Współbieżność.** Zapis i publikacja niosą `expectedRevision`; jeśli ktoś w międzyczasie zapisał zmianę w CMS, RPC zwraca konflikt i skrypt zgłasza błąd tej kolekcji, nie nadpisując niczego.
- **Cel wypisany przed zapisem** (host projektu Supabase). Publikacje są trwałe — rewizje są tylko dopisywane.

Kolejność uruchomienia (poświadczenia `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` produkcji w `.dev.vars` / `--env-file`):

```bash
# 1. Sam plan, nic nie zapisuje — sprawdź host i kolumny set/kept/unchanged:
npm run collections:import-descriptions

# 2. Próba na jednej kolekcji, potem obejrzyj /kolekcje/ostrea w czterech językach:
npm run collections:import-descriptions -- --only ostrea --confirm

# 3. Reszta:
npm run collections:import-descriptions -- --confirm
```

**Kolekcje z partii z 29.09** (Aurora, Cirrus, Cumulonimbus, Cumulus, Obsidian, Scopulus, Unda, Tachylite) mają w CMS krótkie, jednozdaniowe opisy (poniżej 80 znaków) wpisane przez `scripts/complete-new-print-content-2026.ts`. Strona ich nie wyświetla (próg 80 znaków), ale to nie placeholder `<nazwa>.`, więc dry-run oznacza je `kept` i cytuje istniejący tekst. Żeby zastąpić je zatwierdzonymi opisami (poprzednia wersja zostaje w historii rewizji CMS):

```bash
npm run collections:import-descriptions -- --only aurora,cirrus,cumulonimbus,cumulus,obsidian,scopulus,unda,tachylite --force --confirm
```

Po imporcie strona każdej kolekcji z co najmniej 3 pracami staje się indeksowalna w językach, w których opis ma ≥ 80 znaków (tu: wszystkie cztery); pozostałe 10 dostaje opis i zajawkę na `/kolekcje`, ale zostaje `noindex` (punkt 8).

Odrzucone alternatywy: wklejanie 68 tekstów ręcznie w CMS (dużo klikania, brak śladu w repo) oraz zapas w `messages/*.json` jako wartość zastępcza (działałby od razu po merge’u, ale dubluje źródło prawdy — CMS i tak miałby pierwszeństwo).

## 6. Opisy

### Ostrea

Prace: fap001, fap002, fap003, fap006, fap007 (5) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Zaokrąglone, muszlowe formy wypełniające arkusz; półprzejrzyste warstwy szałwii, brzoskwini i dymnej szarości z granatem w środku; jedna prążkowana wstęga (niebieska, terakotowa, bordowa), czasem powtórzona koncentrycznie; mały złoty akcent, rdzawe drobiny, faliste linie konturu.

**PL** (83 słów; zajawka 103 znaków)

> Ostrea to abstrakcyjne obrazy o zaokrąglonych, muszlowych formach, które wypełniają niemal cały arkusz. Akwarela i tusz układają się tu w półprzejrzyste warstwy szałwiowej zieleni, brzoskwini i dymnej szarości, a w środku zbiera się głęboki granat. Formę prowadzi jedna, drobno prążkowana wstęga — niebieska, terakotowa albo bordowa — czasem powtórzona jak koncentryczne pierścienie. Rdzawe drobiny, cienkie linie konturu i mały złoty akcent dodają szczegółu, a biel papieru zostawia wokół dużo oddechu. Fine Art Print z tej kolekcji wprowadzi do salonu, sypialni lub gabinetu spokojną, organiczną głębię.

**EN (UK)** (99 słów; zajawka 103 znaków)

> Ostrea is a series of abstract paintings in rounded, shell-like forms that fill almost the whole sheet. Watercolour and ink settle into translucent layers of sage green, peach and smoky grey, with a pool of deep navy at the centre. A single, finely striped band — blue, terracotta or burgundy — guides each form, sometimes repeated like concentric rings. Rust speckles, fine contour lines and a small gold accent add detail, while the white of the paper leaves plenty of room to breathe. As a Fine Art Print, Ostrea brings a calm, organic depth to a living room, bedroom or study.

**ES** (106 słów; zajawka 104 znaków)

> Ostrea reúne obras abstractas de formas redondeadas, parecidas a conchas, que llenan casi todo el papel. La acuarela y la tinta se superponen en capas translúcidas de verde salvia, melocotón y gris humo, con un azul marino profundo en el centro. Una sola banda de finas rayas —azul, terracota o burdeos— recorre cada forma y a veces se repite como anillos concéntricos. Las motas color óxido, las líneas finas de contorno y un pequeño acento dorado aportan detalle, y el blanco del papel deja mucho espacio para respirar. Como Fine Art Print, Ostrea lleva una calma orgánica y profunda al salón, al dormitorio o al despacho.

**DE** (89 słów; zajawka 98 znaków)

> Ostrea vereint abstrakte Bilder in runden, muschelartigen Formen, die fast das ganze Blatt füllen. Aquarell und Tusche legen sich in durchscheinenden Schichten aus Salbeigrün, Pfirsich und Rauchgrau übereinander, in der Mitte sammelt sich tiefes Marineblau. Ein einzelnes, fein gestreiftes Band — blau, terrakottafarben oder bordeauxrot — führt durch jede Form und wiederholt sich manchmal wie konzentrische Ringe. Rostfarbene Sprenkel, feine Konturlinien und ein kleiner goldener Akzent setzen Details, das Weiß des Papiers lässt viel Raum zum Atmen. Als Fine Art Print bringt Ostrea ruhige, organische Tiefe in Wohnzimmer, Schlafzimmer oder Arbeitszimmer.

### Gestures

Prace: fap010, fap012, fap014, fap016, fap011, fap038, fap039, fap015 (8) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Zamaszyste, zapętlone prążkowane wstęgi (granat, brąz, szarość), szerokie plamy błękitnej szarości, rdzy i brzoskwini, rozbryzgi, zacieki, cienkie linie jak wachlarz włosia; kobaltowe akcenty; dwie prace spokojniejsze, pejzażowe (poziomy pas i jego odbicie).

**PL** (89 słów; zajawka 108 znaków)

> W Gestures widać ruch ręki: zamaszyste pętle, szerokie pociągnięcia pędzla i cienkie, rozchodzące się linie. W tych abstrakcyjnych obrazach akwarela i tusz zachowują ślad pracy — prążkowane wstęgi w granacie, brązie i szarości przecinają plamy błękitnej szarości, rdzy i brzoskwini, a rozbryzgi i zacieki zostają na papierze jak zapis gestu. Kilka obrazów ożywia intensywny kobalt, dwa inne, z poziomym pasem i jego odbiciem, układają się w spokojniejszy, niemal pejzażowy widok. Dużo bieli sprawia, że energia nie przytłacza. Fine Art Print z tej kolekcji doda salonowi, jadalni lub pracowni pewny rytm.

**EN (UK)** (107 słów; zajawka 99 znaków)

> Gestures show the movement of the hand: sweeping loops, broad brushstrokes and fine, fanning lines. In these abstract paintings, watercolour and ink keep the trace of the work — striped ribbons in navy, brown and grey cut across washes of blue-grey, rust and peach, and splashes and drips stay on the paper like a record of the gesture. Intense cobalt lifts several paintings, while two others, with a horizontal band and its reflection, settle into a quieter, almost landscape-like view. Plenty of white keeps the energy from overwhelming the room. The Fine Art Prints in this collection give a living room, dining room or studio a confident rhythm.

**ES** (118 słów; zajawka 118 znaków)

> En Gestures se ve el movimiento de la mano: lazadas amplias, pinceladas anchas y líneas finas que se abren en abanico. En estas obras abstractas, la acuarela y la tinta conservan la huella del trabajo: cintas de rayas en azul marino, marrón y gris cruzan manchas de gris azulado, óxido y melocotón, y las salpicaduras y los chorretones quedan sobre el papel como el registro de un gesto. Un cobalto intenso anima varias obras, mientras que otras dos, con una franja horizontal y su reflejo, se acercan a un paisaje más sereno. Mucho blanco evita que la energía abrume. Las láminas Fine Art Print de esta colección dan al salón, al comedor o al taller un ritmo seguro.

**DE** (99 słów; zajawka 131 znaków)

> In Gestures sieht man die Bewegung der Hand: ausladende Schleifen, breite Pinselstriche und feine, fächerförmig auslaufende Linien. In diesen abstrakten Bildern bewahren Aquarell und Tusche die Spur der Arbeit — gestreifte Bänder in Marineblau, Braun und Grau durchqueren Flächen aus Blaugrau, Rost und Pfirsich, und Spritzer und herablaufende Farbspuren bleiben auf dem Papier wie eine Aufzeichnung der Geste. Kräftiges Kobalt belebt mehrere Bilder, zwei andere — mit einem waagerechten Streifen und seiner Spiegelung — wirken wie eine ruhigere, fast landschaftliche Ansicht. Viel Weiß verhindert, dass die Energie erdrückt. Die Fine Art Prints dieser Kollektion geben Wohnzimmer, Esszimmer oder Atelier einen sicheren Rhythmus.

### Linea

Prace: fap018, fap036, fap041, fap040, fap035, fap019, fap020, fap021, fap034 (9) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Rysunek na pierwszym planie: pierścienie i owale z gęstych promienistych kresek (turkus, brąz, granat, terakota), cienkie łuki, grafitowe plamy tuszu o rozchodzących się brzegach, terakotowa pętla wstęgi; miękkie plamy szałwii i błękitnej szarości, rdzawe drobiny, dużo bieli.

**PL** (84 słów; zajawka 95 znaków)

> W Linea główną rolę gra rysunek: pierścienie i owale zbudowane z gęstych, promienistych kresek. Turkus, brąz, granat i terakota spotykają się w tych abstrakcyjnych kompozycjach z miękkimi akwarelowymi plamami szałwiowej zieleni i błękitnej szarości. Cienkie łuki, grafitowe plamy tuszu o rozchodzących się brzegach, rdzawe drobiny i terakotowa pętla wstęgi nadają kompozycjom rytm, a wyważony układ zostawia sporo wolnej bieli. Ziemista, spokojna paleta współgra z jasnym drewnem, lnem i stonowanymi ścianami. Kolekcja Fine Art Print Linea sprawdzi się w jadalni, sypialni i miejscu do pracy.

**EN (UK)** (88 słów; zajawka 93 znaków)

> In Linea, the drawn line takes the lead: rings and ovals built from dense, radiating strokes. In these abstract compositions, teal, brown, navy and terracotta meet soft watercolour washes of sage green and blue-grey. Fine arcs, charcoal blooms of ink with feathery edges, rust speckles and a looping terracotta ribbon give each composition its rhythm, and the balanced layouts leave generous white space. The earthy, calm palette works with pale wood, linen and muted walls. The Linea Fine Art Print collection suits a dining room, bedroom or workspace.

**ES** (107 słów; zajawka 109 znaków)

> En Linea el protagonista es el dibujo: anillos y óvalos construidos con trazos densos que se abren en radios. En estas composiciones abstractas, turquesa, marrón, azul marino y terracota se encuentran con suaves manchas de acuarela en verde salvia y gris azulado. Arcos finos, manchas de tinta color grafito de bordes plumosos, motas de óxido y una cinta de terracota en bucle dan ritmo a las composiciones, y su equilibrio deja mucho blanco libre. La paleta terrosa y serena combina con la madera clara, el lino y las paredes suaves. La colección Fine Art Print Linea encaja en un comedor, un dormitorio o un espacio de trabajo.

**DE** (80 słów; zajawka 85 znaków)

> In Linea führt die Zeichnung: Ringe und Ovale aus dichten, strahlenförmigen Strichen. In diesen abstrakten Kompositionen treffen Petrol, Braun, Marineblau und Terrakotta auf weiche Aquarellflächen in Salbeigrün und Blaugrau. Feine Bögen, graphitfarbene Tuscheblüten mit gefransten Rändern, rostfarbene Sprenkel und ein schleifenförmiges Terrakottaband geben den Kompositionen ihren Rhythmus, und die ausgewogene Anordnung lässt viel freies Weiß. Die erdige, ruhige Palette passt zu hellem Holz, Leinen und gedämpften Wänden. Die Kollektion Fine Art Print Linea eignet sich für Esszimmer, Schlafzimmer und Arbeitsplatz.

### Horizons

Prace: fap023, fap026 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Poziome warstwy jak horyzont: błękitnoszare, bursztynowe, oliwkowe plamy (druga praca: wodne błękity, piasek, brzoskwinia), falująca prążkowana wstęga, cienkie linie jak fale, ciemne odbicie, złoty pasek, zacieki.

**PL** (76 słów; zajawka 99 znaków)

> Horizons układają się w poziome warstwy, które przywołują horyzont, choć niczego nie przedstawiają. Błękitnoszare, bursztynowe i oliwkowe plamy — w innej pracy wodne błękity, piasek i brzoskwinia — nakładają się pasami, przecinanymi falującą, prążkowaną wstęgą i cienkimi liniami jak zapis fal. Rdzawe drobiny, ciemne odbicie i złoty akcent zostawiają miejsce na ciszę. Akwarela i tusz budują tu abstrakcyjny, szeroki i miarowy rytm, a Fine Art Print z tej kolekcji dobrze wypełni ścianę nad sofą lub komodą albo hol.

**EN (UK)** (89 słów; zajawka 109 znaków)

> Horizons unfold in horizontal layers that call to mind the horizon, without depicting anything in particular. Blue-grey, amber and olive washes — in another work, watery blues, sand and peach — overlap in bands crossed by an undulating striped ribbon and fine lines like a record of waves. Rust speckles, a dark reflection and a gold accent leave room for stillness. Watercolour and ink build a wide, measured, abstract rhythm, and a Fine Art Print from this collection fills the wall above a sofa or sideboard, or a hallway, with ease.

**ES** (99 słów; zajawka 102 znaków)

> Horizons se despliega en capas horizontales que evocan el horizonte, sin representar nada en concreto. Manchas de gris azulado, ámbar y oliva —en otra obra, azules acuosos, arena y melocotón— se superponen en franjas cruzadas por una cinta de rayas ondulada y por líneas finas como el trazo de las olas. Motas de óxido, un reflejo oscuro y un acento dorado dejan lugar al silencio. La acuarela y la tinta construyen un ritmo abstracto, amplio y pausado, y una lámina Fine Art Print de esta colección llena bien la pared sobre el sofá o la cómoda, o un recibidor.

**DE** (88 słów; zajawka 118 znaków)

> Horizons entfalten sich in waagerechten Schichten, die an einen Horizont erinnern, ohne etwas Bestimmtes darzustellen. Flächen in Blaugrau, Bernstein und Oliv — in einer anderen Arbeit wässrige Blautöne, Sand und Pfirsich — überlagern sich in Streifen, durchzogen von einem welligen, gestreiften Band und feinen Linien wie Wellenspuren. Rostfarbene Sprenkel, eine dunkle Spiegelung und ein goldener Akzent lassen Raum für Stille. Aquarell und Tusche erzeugen einen weiten, gleichmäßigen, abstrakten Rhythmus, und ein Fine Art Print dieser Kollektion füllt die Wand über dem Sofa oder der Kommode ebenso gut wie einen Flur.

### Portals

Prace: fap024, fap027, fap030, fap031, fap032 (5) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Chłodne, świetliste błękity: barwinek, kobalt, indygo; duże półprzejrzyste owale i łuki z białymi szczelinami (jak uchylone drzwi/okna), granatowe plamy tuszu, prążkowane pierścienie w szarości i brązie, blada żółć, złote akcenty, rozbryzgi.

**PL** (81 słów; zajawka 88 znaków)

> Portals to chłodne, świetliste obrazy abstrakcyjne w barwach barwinka, kobaltu i indygo. Duże, półprzejrzyste akwarelowe owale i łuki z białymi szczelinami przywodzą na myśl uchylone drzwi lub okna, a wokół nich zbierają się granatowe plamy tuszu, cienkie linie, rozbryzgi i prążkowane pierścienie w szarości i brązie. Blada żółć i złote akcenty rozjaśniają kilka kompozycji. Spokojna, głęboka gama sprawdzi się w sypialni, w salonie z jasnymi tkaninami i wszędzie tam, gdzie liczy się wyciszenie. Każdy obraz jest dostępny jako Fine Art Print.

**EN (UK)** (81 słów; zajawka 79 znaków)

> Portals are cool, luminous abstract paintings in periwinkle, cobalt and indigo. Large, translucent watercolour ovals and arches with white slits recall half-open doors or windows, gathered round by navy pools of ink, fine lines, splashes and striped rings in grey and brown. Pale yellow and gold accents lift a few of the compositions. The calm, deep palette suits a bedroom, a living room with light textiles, or anywhere that calls for quiet. Every painting is available as a Fine Art Print.

**ES** (88 słów; zajawka 92 znaków)

> Portals son obras abstractas, frías y luminosas, en tonos de azul lavanda, cobalto e índigo. Grandes óvalos y arcos de acuarela translúcida, con rendijas blancas, recuerdan puertas o ventanas entreabiertas, rodeados de manchas de tinta azul marino, líneas finas, salpicaduras y anillos de rayas en gris y marrón. El amarillo pálido y los acentos dorados aclaran algunas composiciones. Su gama serena y profunda funciona en un dormitorio, en un salón de textiles claros y en cualquier lugar que pida calma. Cada obra está disponible como Fine Art Print.

**DE** (78 słów; zajawka 83 znaków)

> Portals sind kühle, leuchtende abstrakte Bilder in Lavendelblau, Kobalt und Indigo. Große, durchscheinende Aquarellovale und -bögen mit weißen Schlitzen erinnern an halb geöffnete Türen oder Fenster; um sie sammeln sich marineblaue Tuschepfützen, feine Linien, Spritzer und gestreifte Ringe in Grau und Braun. Helles Gelb und goldene Akzente erhellen einige Kompositionen. Die ruhige, tiefe Farbwelt passt ins Schlafzimmer, in ein Wohnzimmer mit hellen Stoffen und überall dort, wo Ruhe gefragt ist. Jedes Bild ist als Fine Art Print erhältlich.

### Signs

Prace: fap004, fap005 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Świeża paleta: szałwia, oliwka, cytrynowa żółć, blada błękitnoszarość; owale z promienistych kresek, kremowa pętla jak odręczne pismo, cienkie linie zbiegające się w ciemnej kropli tuszu, dużo bieli.

**PL** (79 słów; zajawka 110 znaków)

> Signs łączą świeże barwy — szałwię, oliwkę i cytrynową żółć — z abstrakcyjnymi formami przypominającymi znaki. Owale zbudowane z promienistych kresek, kremowa pętla jak zapis odręcznego pisma i delikatne linie zbiegające się w ciemnej kropli tuszu prowadzą wzrok po kompozycji, a jasnoniebieskie plamy wnoszą chłód. Akwarela i tusz zostawiają tu dużo wolnej przestrzeni, dzięki czemu obrazy są lekkie i przejrzyste. Fine Art Print z tej kolekcji rozjaśni salon, jadalnię lub kuchnię i dobrze zestawi się z naturalnym drewnem oraz zielenią roślin.

**EN (UK)** (92 słów; zajawka 99 znaków)

> Signs pair fresh colours — sage, olive and lemon yellow — with abstract forms that read like signs. Ovals built from radiating strokes, a cream loop like a line of handwriting and delicate lines converging on a dark drop of ink lead the eye across each composition, while pale blue washes add a cool note. Watercolour and ink leave plenty of open space, so the paintings feel light and clear. The Fine Art Prints from this collection brighten a living room, dining room or kitchen and sit well with natural wood and green plants.

**ES** (93 słów; zajawka 104 znaków)

> Signs combina colores frescos —salvia, oliva y amarillo limón— con formas abstractas que parecen signos. Óvalos construidos con trazos radiales, un bucle crema como un renglón de letra manuscrita y líneas delicadas que convergen en una gota oscura de tinta guían la mirada, mientras las manchas azul claro aportan frescor. La acuarela y la tinta dejan mucho espacio abierto, y las obras resultan ligeras y transparentes. Las láminas Fine Art Print de esta colección alegran un salón, un comedor o una cocina y combinan bien con la madera natural y las plantas verdes.

**DE** (80 słów; zajawka 111 znaków)

> Signs verbinden frische Farben — Salbei, Oliv und Zitronengelb — mit abstrakten Formen, die wie Zeichen wirken. Ovale aus strahlenförmigen Strichen, eine cremefarbene Schleife wie eine Zeile Handschrift und zarte Linien, die in einem dunklen Tuschetropfen zusammenlaufen, führen den Blick durch die Komposition, während hellblaue Flächen Kühle einbringen. Aquarell und Tusche lassen viel offenen Raum, sodass die Bilder leicht und klar wirken. Die Fine Art Prints dieser Kollektion hellen Wohnzimmer, Esszimmer oder Küche auf und passen gut zu Naturholz und grünen Pflanzen.

### Ciala

Prace: fap008, fap033 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Odważne, graficzne, organiczne formy: terakotowy owal z białym pierścieniem i nitkowatymi liniami + beżowoszary prążkowany pierścień z czarnym kaligraficznym śladem; druga praca: pudroworóżowa forma, pierścienie barwinek i rdza, czerwona gwiazda na bladożółtym kole.

**PL** (83 słów; zajawka 93 znaków)

> Ciala to odważniejsze, bardziej graficzne obrazy abstrakcyjne o dużych, organicznych formach. Szerokie plamy akwareli spotykają się tu z precyzyjnym rysunkiem tuszem. Jedna z prac zestawia terakotowy owal — z białym pierścieniem i nitkowatymi liniami — z beżowoszarym pierścieniem przeciętym czarnym, kaligraficznym śladem pędzla; inna łączy pudroworóżową formę z pierścieniami w barwinku i rdzy oraz czerwoną gwiazdą na bladożółtym kole. Ciepłe, ziemiste kolory kontrastują z granatem i błękitem, a całość pozostaje pogodna i uporządkowana. Fine Art Print z tej kolekcji doda charakteru jadalni, pracowni lub holu.

**EN (UK)** (96 słów; zajawka 93 znaków)

> Ciala is a bolder, more graphic series of abstract paintings built from large, organic forms. Broad watercolour washes meet precise drawing in ink. One work sets a terracotta oval with a white ring and thread-like lines beside a beige-grey ring crossed by a black, calligraphic brushmark; another combines a powder-pink form with rings in periwinkle and rust and a red starburst on a pale yellow disc. Warm, earthy colours play against navy and blue, yet the whole stays cheerful and orderly. As a Fine Art Print, Ciala adds character to a dining room, studio or hallway.

**ES** (112 słów; zajawka 90 znaków)

> Ciala es una serie más audaz y gráfica de obras abstractas con formas grandes y orgánicas. Amplias manchas de acuarela se encuentran con un dibujo preciso a tinta. Una de las obras coloca un óvalo terracota con un anillo blanco e hilos finos junto a un anillo beige grisáceo atravesado por un trazo negro caligráfico; otra une una forma rosa empolvado con anillos azul lavanda y óxido y una estrella roja sobre un disco amarillo pálido. Los colores cálidos y terrosos contrastan con el azul marino y el azul, y el conjunto sigue siendo alegre y ordenado. Como Fine Art Print, Ciala da carácter a un comedor, un estudio o un recibidor.

**DE** (88 słów; zajawka 91 znaków)

> Ciala ist eine kühnere, grafischere Serie abstrakter Bilder aus großen, organischen Formen. Breite Aquarellflächen treffen hier auf präzise Zeichnung in Tusche. Eine der Arbeiten stellt ein terrakottafarbenes Oval mit weißem Ring und fadenfeinen Linien neben einen beigegrauen Ring mit schwarzem, kalligrafischem Pinselzug; eine andere verbindet eine puderrosa Form mit Ringen in Lavendelblau und Rost und einem roten Stern auf einer blassgelben Scheibe. Warme, erdige Farben kontrastieren mit Marineblau und Blau, und das Ganze bleibt heiter und geordnet. Als Fine Art Print verleiht Ciala Esszimmer, Atelier oder Flur Charakter.

### Balance

Prace: fap028, fap025 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Formy ustawione jedna na drugiej jak wyważone kamienie: stalowy błękit i turkus + pomarańcz nakrapiany rdzą; prążkowane pierścienie (bordo), cienkie linie, ciemny rozbryzg, jasne sześciokątne okno; blada żółć z niebieskimi wstęgami.

**PL** (69 słów; zajawka 90 znaków)

> Balance to abstrakcyjne formy ustawione jedna na drugiej, jak starannie wyważone kamienie. Chłodny błękit i turkus akwareli spotykają tu ciepły pomarańcz nakrapiany rdzą, a prążkowane pierścienie, cienkie linie i ciemny rozbryzg tuszu albo jasne, sześciokątne okno dodają szczegółu. Sporo bieli papieru i wyraźny kontrast temperatur barw sprawiają, że układ jest zabawny, ale nie przeładowany. Kolekcja Fine Art Print Balance ożywi jadalnię, salon lub pracownię — szczególnie tam, gdzie brakuje koloru.

**EN (UK)** (78 słów; zajawka 92 znaków)

> Balance is built from abstract forms stacked one on another, like carefully balanced stones. Cool watercolour blue and turquoise meet warm orange flecked with rust, while striped rings, fine lines and a dark splash of ink or a pale hexagonal window add detail. Plenty of white paper and a clear contrast of temperatures keep the composition playful but uncluttered. The Balance Fine Art Print collection brightens a dining room, living room or studio — especially where colour is missing.

**ES** (91 słów; zajawka 109 znaków)

> Balance se construye con formas abstractas apiladas una sobre otra, como piedras cuidadosamente equilibradas. El azul frío y el turquesa de la acuarela se encuentran con un naranja cálido moteado de óxido, y los anillos de rayas, las líneas finas y una salpicadura oscura de tinta o una ventana hexagonal clara aportan detalle. El blanco del papel y un claro contraste de temperaturas hacen que la composición sea juguetona sin resultar recargada. La colección Fine Art Print Balance anima un comedor, un salón o un estudio, sobre todo donde falta color.

**DE** (67 słów; zajawka 103 znaków)

> Balance besteht aus abstrakten Formen, die wie sorgfältig austarierte Steine aufeinandergestapelt sind. Kühles Aquarellblau und Türkis treffen auf warmes, rostgesprenkeltes Orange, während gestreifte Ringe, feine Linien und ein dunkler Tuschespritzer oder ein helles sechseckiges Fenster Details setzen. Viel weißes Papier und ein klarer Temperaturkontrast machen die Komposition verspielt, aber nicht überladen. Die Kollektion Fine Art Print Balance belebt Esszimmer, Wohnzimmer oder Atelier — besonders dort, wo Farbe fehlt.

### Verticles

Prace: fap009, fap013, fap017, fap022 (4) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Kompozycje prowadzone pionem: wstęgi, kolumny, pasy; cztery różne palety (piasek/szarość + czarna i błękitna wstęga; beż z ciemnym prążkowanym słupem; żółć-oliwka z jasnym pierścieniem i białymi kropkami; lawenda, blada żółć, róż, kobalt).

**PL** (79 słów; zajawka 92 znaków)

> W Verticles kompozycję prowadzi pion: wstęgi, kolumny i pasy schodzą od góry do dołu obrazu. Każda praca ma inną paletę — piaskowe i szare pola z czarną oraz błękitną wstęgą, ziemisty beż z ciemnym, prążkowanym słupem, żółć z oliwką i jasnym pierścieniem albo lawenda, blada żółć i kobalt — ale łączy je wspólny, spokojny rytm. Akwarela i tusz tworzą wysokie, wyważone układy abstrakcyjne, które dobrze wykorzystają wąską ścianę, przestrzeń przy drzwiach lub hol. Każdy obraz jest dostępny jako Fine Art Print.

**EN (UK)** (95 słów; zajawka 108 znaków)

> In Verticles, the vertical leads: ribbons, columns and bands run from the top of the painting to the bottom. Each work has its own palette — sand and grey fields with a black and a blue ribbon, earthy beige with a dark striped column, yellow with olive and a pale ring, or lavender, pale yellow and cobalt — but they share a calm rhythm. Watercolour and ink form tall, balanced abstract layouts that make good use of a narrow wall, the space by a door or a hallway. Every painting is available as a Fine Art Print.

**ES** (94 słów; zajawka 91 znaków)

> En Verticles manda la vertical: cintas, columnas y bandas recorren la obra de arriba abajo. Cada obra tiene su propia paleta —campos de arena y gris con una cinta negra y otra azul, beige terroso con una columna de rayas oscura, amarillo con oliva y un anillo pálido, o lavanda, amarillo pálido y cobalto—, pero las une un ritmo sereno. La acuarela y la tinta crean composiciones abstractas, altas y equilibradas, que aprovechan bien una pared estrecha, el espacio junto a una puerta o un recibidor. Cada una está disponible como Fine Art Print.

**DE** (89 słów; zajawka 121 znaków)

> In Verticles bestimmt die Senkrechte die Komposition: Bänder, Säulen und Streifen laufen von oben nach unten durchs Bild. Jede Arbeit hat ihre eigene Palette — Sand und Grau mit einem schwarzen und einem blauen Band, erdiges Beige mit einer dunklen gestreiften Säule, Gelb mit Oliv und einem hellen Ring oder Lavendel, Blassgelb und Kobalt —, doch sie teilen einen ruhigen Rhythmus. Aquarell und Tusche schaffen hohe, ausgewogene abstrakte Anordnungen, die eine schmale Wand, den Platz neben einer Tür oder einen Flur gut nutzen. Jedes Bild ist als Fine Art Print erhältlich.

### Aurora

Prace: fap042, fap043, fap044 (3) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Płynne pionowe pasma jak zasłony światła: szałwia, przygaszony róż, błękitna szarość, kość słoniowa; ciemne plamy tuszu z musztardową poświatą, granatowa plama jak kwiat, złote akcenty; prążkowane wstęgi w terakocie i granacie.

**PL** (75 słów; zajawka 75 znaków)

> Aurora to płynne, pionowe pasma akwareli, które falują jak zasłony światła. Szałwiowa zieleń, przygaszony róż, błękitna szarość i kość słoniowa sąsiadują z ciemnymi plamami tuszu — z musztardową poświatą, granatową plamą przypominającą kwiat albo złotym akcentem — oraz z prążkowanymi wstęgami w terakocie i granacie. Miękkie przejścia równoważą wyraźny, graficzny rysunek tych abstrakcyjnych kompozycji. Chłodna, stonowana paleta współgra z jasnym drewnem i lnem, a Fine Art Print z tej kolekcji doda sypialni lub salonowi lekki, wysoki akcent.

**EN (UK)** (88 słów; zajawka 97 znaków)

> Aurora is a series of flowing vertical bands of watercolour that undulate like curtains of light. Sage green, muted pink, blue-grey and ivory sit beside dark blooms of ink — with a mustard halo, a navy flower-like shape or a gold accent — and striped ribbons in terracotta and navy. Soft transitions balance the crisp, graphic line of these abstract compositions. The cool, gentle palette works with pale wood and linen, and the Fine Art Prints in this collection add a light, tall accent to a bedroom or living room.

**ES** (104 słów; zajawka 86 znaków)

> Aurora reúne bandas verticales de acuarela, fluidas, que ondulan como cortinas de luz. El verde salvia, el rosa apagado, el gris azulado y el marfil conviven con manchas oscuras de tinta —con un halo mostaza, una forma azul marino como una flor o un acento dorado— y con cintas de rayas en terracota y azul marino. Las transiciones suaves equilibran el dibujo nítido y gráfico de estas composiciones abstractas. La paleta fría y suave combina con la madera clara y el lino, y las láminas Fine Art Print de esta colección añaden un acento alto y ligero a un dormitorio o a un salón.

**DE** (75 słów; zajawka 87 znaków)

> Aurora besteht aus fließenden, senkrechten Aquarellbahnen, die wie Lichtvorhänge wogen. Salbeigrün, gedämpftes Rosa, Blaugrau und Elfenbein stehen neben dunklen Tuscheflecken — mit senfgelbem Hof, einer marineblauen, blütenartigen Form oder einem goldenen Akzent — und gestreiften Bändern in Terrakotta und Marineblau. Sanfte Übergänge gleichen die klare, grafische Linie dieser abstrakten Kompositionen aus. Die kühle, zarte Palette passt zu hellem Holz und Leinen, und die Fine Art Prints dieser Kollektion setzen einen leichten, hohen Akzent im Schlafzimmer oder Wohnzimmer.

### Cirrus

Prace: fap045, fap058 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Lekkie, chłodne błękity (barwinek, kobalt) z jedną intensywnie pomarańczową krawędzią; prążkowany pierścień ze złotym akcentem, rdzawe drobiny, ciemne plamy tuszu jak kwiaty/dmuchawce z cienkimi liniami; bardzo dużo bieli.

**PL** (69 słów; zajawka 119 znaków)

> Cirrus to lekkie, abstrakcyjne obrazy w chłodnych błękitach, w których jedna ciepła krawędź nadaje kompozycji napięcie. Barwinek i kobalt rozpływają się w przejrzystych plamach akwareli, obok pojawiają się intensywny pomarańcz, prążkowany pierścień ze złotym akcentem, rdzawe drobiny i ciemne, rozkwitające plamy tuszu z cienkimi liniami. Bardzo dużo bieli wokół form pozwala kompozycjom oddychać. Fine Art Print z tej kolekcji wniesie świeży, pogodny akcent do jasnego salonu, sypialni lub gabinetu.

**EN (UK)** (79 słów; zajawka 121 znaków)

> Cirrus is a series of airy abstract paintings in cool blues, where a single warm edge gives each composition its tension. Periwinkle and cobalt melt into translucent watercolour washes, alongside vivid orange, a striped ring with a gold accent, rust speckles and dark, blooming spots of ink with fine lines. Plenty of white around the forms lets the compositions breathe. As a Fine Art Print, Cirrus brings a fresh, cheerful note to a bright living room, bedroom or study.

**ES** (90 słów; zajawka 114 znaków)

> Cirrus reúne obras abstractas y ligeras en azules fríos, donde un solo borde cálido da tensión a cada composición. El azul lavanda y el cobalto se funden en manchas translúcidas de acuarela, junto a un naranja vivo, un anillo de rayas con un acento dorado, motas de óxido y manchas de tinta oscuras que florecen con líneas finas. Mucho blanco alrededor de las formas deja respirar las composiciones. Como Fine Art Print, Cirrus aporta un toque fresco y alegre a un salón luminoso, a un dormitorio o a un despacho.

**DE** (70 słów; zajawka 127 znaków)

> Cirrus vereint luftige abstrakte Bilder in kühlen Blautönen, in denen ein einziger warmer Rand jeder Komposition Spannung gibt. Lavendelblau und Kobalt verlaufen in durchscheinenden Aquarellflächen, daneben stehen leuchtendes Orange, ein gestreifter Ring mit goldenem Akzent, rostfarbene Sprenkel und dunkle, aufblühende Tuscheflecken mit feinen Linien. Viel Weiß um die Formen lässt die Kompositionen atmen. Als Fine Art Print bringt Cirrus eine frische, heitere Note in ein helles Wohnzimmer, Schlafzimmer oder Arbeitszimmer.

### Cumulonimbus

Prace: fap046, fap047 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Szerokie, poziome warstwy jak zachmurzone niebo: jasny błękit i turkus, ochra, bursztyn, ziemiste brązy; ciemny poziomy pas; cienkie linie od plamy tuszu, rdzawe drobiny, złote prostokąty, zacieki jak deszcz.

**PL** (71 słów; zajawka 99 znaków)

> Cumulonimbus to szerokie, poziome kompozycje abstrakcyjne, które kojarzą się z zachmurzonym niebem. Jasny błękit i turkus akwareli sąsiadują tu z ochrą, bursztynem i ziemistymi brązami, a ciemny, poziomy pas dzieli obraz na warstwy. Cienkie linie rozchodzą się od plamy tuszu, rdzawe drobiny zagęszczają się jak chmury, a złote prostokąty i smugi spływającego pigmentu dodają dramaturgii, nie odbierając obrazom miękkości. Kolekcja Fine Art Print Cumulonimbus zbuduje nastrój w salonie, sypialni lub gabinecie.

**EN (UK)** (78 słów; zajawka 95 znaków)

> Cumulonimbus brings together wide, horizontal abstract compositions that suggest a clouded sky. Pale blue and turquoise watercolour sit with ochre, amber and earthy browns, and a dark horizontal band divides each painting into layers. Fine lines radiate from a blot of ink, rust speckles gather like clouds, and gold rectangles and trails of running pigment add drama without taking away the softness. The Cumulonimbus Fine Art Print collection sets a mood in a living room, bedroom or study.

**ES** (88 słów; zajawka 100 znaków)

> Cumulonimbus reúne composiciones abstractas, amplias y horizontales, que sugieren un cielo cubierto. El azul claro y el turquesa de la acuarela se combinan con ocre, ámbar y marrones terrosos, y una franja oscura horizontal divide cada obra en capas. Líneas finas se abren desde una mancha de tinta, las motas de óxido se agrupan como nubes, y los rectángulos dorados y las gotas de pigmento que resbalan aportan dramatismo sin quitar suavidad. La colección Fine Art Print Cumulonimbus crea ambiente en un salón, un dormitorio o un despacho.

**DE** (71 słów; zajawka 104 znaków)

> Cumulonimbus vereint weite, waagerechte abstrakte Kompositionen, die an einen bewölkten Himmel erinnern. Helles Aquarellblau und Türkis treffen auf Ocker, Bernstein und erdige Brauntöne, ein dunkler waagerechter Streifen teilt jedes Bild in Schichten. Feine Linien strahlen von einem Tuscheklecks aus, rostfarbene Sprenkel verdichten sich wie Wolken, und goldene Rechtecke und herablaufende Pigmentspuren geben Dramatik, ohne die Weichheit zu nehmen. Die Kollektion Fine Art Print Cumulonimbus schafft Stimmung in Wohnzimmer, Schlafzimmer oder Arbeitszimmer.

### Cumulus

Prace: fap048, fap049 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Miękkie, ciepłe, rozpływające się kształty: kremowo-brzoskwiniowa baza, smugi ochry, pomarańczu i rdzy; cienkie linie kończące się małymi rozkwitającymi plamami tuszu jak dmuchawce; błękitnoszare pasma, złote akcenty, dużo bieli.

**PL** (69 słów; zajawka 90 znaków)

> Cumulus to miękkie, ciepłe obrazy abstrakcyjne o kształtach rozpływających się jak obłoki. Z kremowej i brzoskwiniowej podstawy z akwareli wyrastają smugi ochry, pomarańczu i rdzy, a cienkie linie kończą się małymi, rozkwitającymi plamami tuszu, podobnymi do dmuchawców. Błękitnoszare pasma i złote akcenty równoważą ciepło, a szerokie pola białego papieru dają wytchnienie. Fine Art Print z tej kolekcji pasuje do jasnej sypialni, kącika do czytania lub salonu z ciepłymi tkaninami.

**EN (UK)** (82 słów; zajawka 87 znaków)

> Cumulus is a series of soft, warm abstract paintings whose shapes dissolve like clouds. From a cream and peach watercolour base rise streaks of ochre, orange and rust, and fine lines end in small, blooming spots of ink that recall dandelion heads. Blue-grey bands and gold accents balance the warmth, and wide fields of white paper give the eye a rest. The Fine Art Prints in this collection suit a bright bedroom, a reading corner or a living room with warm textiles.

**ES** (94 słów; zajawka 97 znaków)

> Cumulus es una serie de obras abstractas, suaves y cálidas, de formas que se deshacen como nubes. De una base de acuarela crema y melocotón brotan vetas de ocre, naranja y óxido, y líneas finas terminan en pequeñas manchas de tinta que florecen y recuerdan a un diente de león. Las franjas de gris azulado y los acentos dorados equilibran el calor, y los amplios campos de papel blanco dan respiro. Las láminas Fine Art Print de esta colección encajan en un dormitorio luminoso, un rincón de lectura o un salón con textiles cálidos.

**DE** (74 słów; zajawka 96 znaków)

> Cumulus ist eine Serie weicher, warmer abstrakter Bilder, deren Formen sich wie Wolken auflösen. Aus einer Aquarellgrundlage in Creme und Pfirsich wachsen Schlieren aus Ocker, Orange und Rost, und feine Linien enden in kleinen, aufblühenden Tuscheflecken, die an Pusteblumen erinnern. Blaugraue Bahnen und goldene Akzente balancieren die Wärme, und weite Flächen weißen Papiers geben Ruhe. Die Fine Art Prints dieser Kollektion passen in ein helles Schlafzimmer, eine Leseecke oder ein Wohnzimmer mit warmen Textilien.

### Obsidian

Prace: fap050, fap051, fap052, fap053 (4) — kwalifikuje się do indeksacji (co najmniej 3 prace).

**Co widać:** Ziemiste, graficzne konstrukcje z owali i pierścieni: piasek, krem, rdzawy brąz, oliwka, chłodna szarość; promieniste kreski, plamy pigmentu z jasnymi punktami, czarny kaligraficzny gest, gwiazda z grubych kresek, fragment jak otoczaki; pionowe układy z dużym marginesem bieli.

**PL** (82 słów; zajawka 74 znaków)

> Obsidian to ziemiste kompozycje abstrakcyjne ułożone z owali i pierścieni. Paletę tworzą piasek, krem, rdzawy brąz, oliwka i chłodna szarość. Jedne formy zbudowane są z gęstych, promienistych kresek, inne z plam pigmentu rozkwitających jasnymi punktami; pojawiają się też czarny, kaligraficzny gest, gwiazda z grubych kresek i fragment przypominający otoczaki. Akwarela i tusz tworzą wyważone, pionowe konstrukcje z dużym marginesem bieli. Ciepła, stonowana gama ociepli oszczędne wnętrze, jadalnię lub hol, a Fine Art Print z tej kolekcji dobrze zagra z drewnem i lnem.

**EN (UK)** (102 słów; zajawka 80 znaków)

> Obsidian is a series of earthy abstract compositions built from ovals and rings. The palette is sand, cream, rusty brown, olive and cool grey. Some forms are made of dense, radiating strokes, others of pigment washes in which pale spots bloom; there is also a black, calligraphic gesture, a star of heavy strokes and a patch that recalls pebbles. Watercolour and ink form balanced, vertical constructions with a generous margin of white. These warm, muted colours bring warmth to a spare interior, a dining room or a hallway, and the Fine Art Prints in this collection sit well with wood and linen.

**ES** (115 słów; zajawka 88 znaków)

> Obsidian es una serie de composiciones abstractas y terrosas hechas de óvalos y anillos. Su paleta reúne arena, crema, marrón óxido, oliva y gris frío. Unas formas están construidas con trazos densos en abanico; otras, con manchas de pigmento en las que florecen puntos claros; aparecen también un gesto negro caligráfico, una estrella de trazos gruesos y un fragmento que recuerda a guijarros. La acuarela y la tinta dan lugar a construcciones verticales y equilibradas, con un generoso margen blanco. Estos tonos, cálidos y contenidos, dan calor a un interior austero, a un comedor o a un recibidor, y las láminas Fine Art Print de esta colección combinan bien con la madera y el lino.

**DE** (96 słów; zajawka 79 znaków)

> Obsidian ist eine Serie erdiger abstrakter Kompositionen aus Ovalen und Ringen. Die Palette reicht von Sand und Creme über Rostbraun und Oliv bis zu kühlem Grau. Manche Formen bestehen aus dichten, strahlenförmigen Strichen, andere aus Pigmentflächen, in denen helle Punkte aufblühen; dazu kommen eine schwarze, kalligrafische Geste, ein Stern aus kräftigen Strichen und ein Ausschnitt, der an Kieselsteine erinnert. Aquarell und Tusche bilden ausgewogene, senkrechte Konstruktionen mit großzügigem weißen Rand. Diese warmen, gedämpften Töne verleihen einem schlichten Interieur, einem Esszimmer oder einem Flur Wärme, und die Fine Art Prints dieser Kollektion harmonieren mit Holz und Leinen.

### Scopulus

Prace: fap054 (1) — za mało prac na indeksację (min. 3).

**Co widać:** Dwie wydłużone formy: ciepły ochrowo-rdzawy brąz z białymi dmuchawcowymi plamami tuszu i nitkowatymi liniami + jasnoniebieski, nakrapiany owal; kremowy promienisty pierścień u góry; dwa małe terakotowe ślady.

**PL** (73 słów; zajawka 111 znaków)

> Scopulus to spokojny, abstrakcyjny duet dwóch wydłużonych form: ciepłego brązu i jasnego, nakrapianego błękitu. Ochrowo-rdzawa forma ma białe, dmuchawcowe plamy tuszu i nitkowate linie, a akwarela i drobny rysunek spotykają się w kremowym pierścieniu z cienkich kresek, który zamyka górę kompozycji; dwa małe, terakotowe ślady dodają jej lekkości. Prosty układ i wyraźny kontrast temperatur barw dają obraz pogodny i wyważony. Fine Art Print Scopulus wniesie równowagę do sypialni, salonu lub miejsca do pracy.

**EN (UK)** (84 słów; zajawka 97 znaków)

> Scopulus is a calm, abstract duet of two elongated forms: a warm brown and a pale, speckled blue. The ochre-rust form carries white, dandelion-like blooms of ink and thread-like lines, while watercolour and fine drawing meet in a cream ring of delicate strokes that closes the top of the composition; two small terracotta marks give it lightness. The simple layout and clear contrast of temperatures make a cheerful, balanced picture. The Scopulus Fine Art Print brings balance to a bedroom, living room or workspace.

**ES** (101 słów; zajawka 104 znaków)

> Scopulus es un dúo abstracto y sereno de dos formas alargadas: un marrón cálido y un azul claro moteado. La forma ocre y óxido lleva flores de tinta blancas como dientes de león e hilos finos, y la acuarela y el dibujo fino se encuentran en un anillo crema de trazos delicados que cierra la parte superior de la composición; dos pequeñas marcas de terracota le dan ligereza. La composición sencilla y el claro contraste de temperaturas dan una obra alegre y equilibrada. La lámina Fine Art Print Scopulus aporta equilibrio a un dormitorio, un salón o un espacio de trabajo.

**DE** (79 słów; zajawka 119 znaków)

> Scopulus ist ein ruhiges, abstraktes Duo zweier länglicher Formen: ein warmes Braun und ein helles, gesprenkeltes Blau. Die ocker-rostfarbene Form trägt weiße, pusteblumenartige Tuscheblüten und fadenfeine Linien, und Aquarell und feine Zeichnung treffen sich in einem cremefarbenen Ring aus zarten Strichen, der die Komposition oben abschließt; zwei kleine Terrakotta-Zeichen geben ihr Leichtigkeit. Der schlichte Aufbau und der klare Temperaturkontrast ergeben ein heiteres, ausgewogenes Bild. Der Fine Art Print Scopulus bringt Ausgewogenheit ins Schlafzimmer, ins Wohnzimmer oder an den Arbeitsplatz.

### Unda

Prace: fap055, fap056 (2) — za mało prac na indeksację (min. 3).

**Co widać:** Chłodne, płynne błękity, kobalt i piasek: dwie wydłużone formy (beż, jasny błękit) z prążkowanym pierścieniem i kobaltowymi plamami; rozlewna forma opadająca ku ciemnemu poziomemu pasmu z liniami jak fale i złotym akcentem; dużo bieli.

**PL** (74 słów; zajawka 75 znaków)

> Unda to chłodne, płynne obrazy abstrakcyjne w błękitach, kobalcie i piasku. W jednej pracy dwie wydłużone formy, beżowa i jasnoniebieska, przecina prążkowany pierścień, a nasycony kobalt skupia się w kilku plamach; w innej rozlewna forma w odcieniach błękitu i szarości opada ku ciemnemu, poziomemu pasmu z cienkimi liniami tuszu jak fale i złotym akcentem. Przejrzyste warstwy akwareli i dużo białego papieru dają wrażenie lekkości. Kolekcja Fine Art Print Unda uspokoi salon, sypialnię lub gabinet.

**EN (UK)** (90 słów; zajawka 77 znaków)

> Unda is a series of cool, fluid abstract paintings in blues, cobalt and sand. In one work a striped ring crosses two elongated forms, one beige and one pale blue, and intense cobalt gathers in a few spots; in another, a sprawling form in blues and greys sinks towards a dark horizontal band with fine ink lines like waves and a gold accent. Translucent layers of watercolour and plenty of white paper give a sense of lightness. The Unda Fine Art Print collection calms a living room, bedroom or study.

**ES** (96 słów; zajawka 83 znaków)

> Unda es una serie de obras abstractas, frías y fluidas, en azules, cobalto y arena. En una, un anillo de rayas cruza dos formas alargadas, una beige y otra azul claro, y el cobalto intenso se concentra en unas pocas manchas; en otra, una forma expansiva en tonos azules y grises desciende hacia una franja horizontal oscura, con líneas finas de tinta como olas y un acento dorado. Las capas transparentes de acuarela y el abundante papel blanco dan sensación de ligereza. La colección Fine Art Print Unda serena un salón, un dormitorio o un despacho.

**DE** (80 słów; zajawka 82 znaków)

> Unda ist eine Serie kühler, fließender abstrakter Bilder in Blau, Kobalt und Sand. In einer Arbeit kreuzt ein gestreifter Ring zwei längliche Formen, eine beige und eine hellblaue, und kräftiges Kobalt sammelt sich in wenigen Flecken; in einer anderen sinkt eine ausladende Form in Blau- und Grautönen zu einem dunklen, waagerechten Streifen mit feinen Tuschelinien wie Wellen und einem goldenen Akzent. Durchscheinende Aquarellschichten und viel weißes Papier vermitteln Leichtigkeit. Die Kollektion Fine Art Print Unda beruhigt Wohnzimmer, Schlafzimmer oder Arbeitszimmer.

### Tachylite

Prace: fap057 (1) — za mało prac na indeksację (min. 3).

**Co widać:** Piętrowa kompozycja z pierścieni i owali: nakrapiany rdzą ochrowy pierścień, turkusowy promienisty owal, mały bordowy pierścień; obok jasna forma z niebieską wstęgą i falującymi liniami zakończonymi dwiema ciemnymi kroplami.

**PL** (69 słów; zajawka 106 znaków)

> Tachylite to piętrowa kompozycja abstrakcyjna z pierścieni i owali w turkusie, ochrze i ciemnej czerwieni. Nakrapiany rdzą pierścień, promienisty niebieski owal i mały, bordowy pierścień układają się jeden nad drugim, a obok wznosi się jasna forma z falującymi liniami zakończonymi dwiema ciemnymi kroplami tuszu. Akwarela i tusz łączą tu ziemiste ciepło z chłodnym turkusem, dając obraz graficzny i swobodny. Fine Art Print Tachylite ożywi jadalnię, hol lub jasny salon.

**EN (UK)** (85 słów; zajawka 96 znaków)

> Tachylite is a stacked abstract composition of rings and ovals in turquoise, ochre and deep red. A rust-flecked ring, a blue oval of radiating strokes and a small burgundy ring pile up one above another, while beside them rises a pale form with wavy lines ending in two dark drops of ink. Watercolour and ink set earthy warmth against cool turquoise, making a picture that is graphic and unforced. The Tachylite Fine Art Print brings life to a dining room, hallway or bright living room.

**ES** (92 słów; zajawka 101 znaków)

> Tachylite es una composición abstracta y apilada de anillos y óvalos en turquesa, ocre y rojo oscuro. Un anillo moteado de óxido, un óvalo azul de trazos radiales y un pequeño anillo burdeos se apilan uno sobre otro, y a su lado se alza una forma clara con líneas onduladas que terminan en dos gotas oscuras de tinta. La acuarela y la tinta enfrentan el calor terroso al turquesa frío y dan una obra gráfica y desenfadada. La lámina Fine Art Print Tachylite anima un comedor, un recibidor o un salón luminoso.

**DE** (75 słów; zajawka 108 znaków)

> Tachylite ist eine gestapelte, abstrakte Komposition aus Ringen und Ovalen in Türkis, Ocker und dunklem Rot. Ein rostgesprenkelter Ring, ein blaues Oval aus strahlenförmigen Strichen und ein kleiner bordeauxroter Ring stapeln sich übereinander, daneben erhebt sich eine helle Form mit welligen Linien, die in zwei dunklen Tuschetropfen enden. Aquarell und Tusche setzen erdige Wärme gegen kühles Türkis und ergeben ein grafisches, unbeschwertes Bild. Der Fine Art Print Tachylite belebt Esszimmer, Flur oder ein helles Wohnzimmer.
