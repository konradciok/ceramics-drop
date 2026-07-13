# Complete InPost bulk-shipment export

Wygenerowano z `exports/orders.csv` (pełny eksport zamówień z Supabase, `scripts/export-orders-csv.ts`) dla 19 zamówień wskazanych przez użytkownika.

## Zamówienia poza tym eksportem

**`1d5d74bb-3ff1-4894-86d5-b1e3fb622f54`** (Magda Deńca, deneese@o2.pl) ma `delivery_method = odbior` — osobisty odbiór w Warszawie, **nie jest przesyłką InPost** (`needsShipment('odbior') === false` w `src/lib/shipx.ts`). Nie ma dla niego numeru paczkomatu ani przesyłki ShipX — wykluczony z tabeli poniżej.

Pozostałe 18 zamówień to `paczkomat`.

## Zasady wypełnienia pól

Wypełnione na podstawie realnych danych z systemu:

- **e-mail, telefon, imie_i_nazwisko** — z `orders` (`email`, `receiver_phone`, `receiver_first_name` + `receiver_last_name`).
- **telefon** — znormalizowany: usunięte spacje, dodany prefiks `+48` tam gdzie w bazie zapisano tylko 9 cyfr (wszystkie numery są polskie).
- **paczkomat** — `inpost_target_point`.
- **numer_referencyjny** — UUID zamówienia (`order.id`); to jest dokładnie to, co `buildShipmentPayload()` w `src/lib/shipx.ts` wysyła jako `reference` do ShipX — najbezpieczniejszy, jednoznaczny identyfikator do wyszukania zamówienia w `npm run orders`/`/admin`.
- **rozmiar** — `B` dla wszystkich: kod używa jednego stałego rozmiaru paczkomatowego (`DEFAULT_LOCKER_PARCEL = { template: 'medium' }`, brak sizingu per-produkt), a `medium` odpowiada rozmiarowi **B** w skali InPost A/B/C.
- **typ_przesylki** — `paczkomat` (wszystkie 18 zamówień).

Celowo pozostawione puste — sklep **nie zbiera** tych danych przy checkoucie (patrz `DeliveryContact`/`DeliverySelection` w `src/lib/shipx.ts`), więc ich wypełnienie byłoby zmyślaniem danych, nie ich odczytem:

- **nazwa_firmy** — brak pola firmy w formularzu zamówienia.
- **dodatkowa_ochrona** — brak zbieranej wartości ubezpieczenia; do ustalenia ręcznie, jeśli potrzebne (wartość paczki widoczna w `exports/orders.csv` jako `subtotal_display`).
- **za_pobraniem** — nie dotyczy: wszystkie zamówienia są już opłacone przez Stripe, nie ma płatności za pobraniem.
- **ulica, kod_pocztowy, miejscowosc** — nie dotyczy paczkomatu (adres dostawy istnieje tylko dla `kurier`; żadne z tych 18 zamówień nie jest kurierem).
- **paczka_w_weekend** — brak takiej opcji w checkoucie tego sklepu.

## CSV (InPost — nadania masowe)

```csv
e-mail;telefon;rozmiar;paczkomat;numer_referencyjny;dodatkowa_ochrona;za_pobraniem;imie_i_nazwisko;nazwa_firmy;ulica;kod_pocztowy;miejscowosc;typ_przesylki;paczka_w_weekend
patrycja.binkowska96@gmail.com;+48604451968;B;MSV01M;3b7149a7-228d-4e2f-aa13-e13b268673ee;;;Patrycja Rybczyńska;;;;;paczkomat;
dorosiac@wp.pl;+48500212139;B;LOD49A;95ed7410-ad61-433a-b854-d28b24b16fb2;;;Dorota Cwynar;;;;;paczkomat;
skowronska.kinga@op.pl;+48508171102;B;RAD58M;8f1c9163-b24d-4a81-8e86-e4b98ef36458;;;Kinga Skowrońska;;;;;paczkomat;
justin434@wp.pl;+48792550193;B;SCI02BAPP;22feef10-1069-491b-bf54-8ee0a37d527e;;;Justyna Budzanowska;;;;;paczkomat;
justin434@wp.pl;+48792550193;B;SCI01M;ee61f7cb-b86b-40a9-a5f8-eb6c2d87590b;;;Justyna Budzanowska;;;;;paczkomat;
malgorzatarutkowska13@gmail.com;+48500669705;B;GDA27A;0028a7b3-d6a0-406a-84f8-c8f279ba13cf;;;Małgorzata Rutkowska;;;;;paczkomat;
julia.grala0@gmail.com;+48512314997;B;WRO07L;c617cbe5-db55-4fa9-aaa3-92f7df70a63f;;;Julia Kozioł;;;;;paczkomat;
jolanta.sam@wp.pl;+48501352826;B;WAW726M;e1e0e0b6-56c0-41a6-9a23-76a148f6b582;;;Jola Sampławska;;;;;paczkomat;
agatajanik7@gmail.com;+48695936108;B;TYC23M;75116c97-ce3f-4391-a77a-dfb4ade84709;;;Agata Janik;;;;;paczkomat;
onemoretry@wp.pl;+48570032995;B;ZGO75M;c7a5fb38-435d-4355-8c60-36d9053dce88;;;Ania Żeleźnik;;;;;paczkomat;
karinazygmont@gmail.com;+48508191147;B;KRA101M;9590e592-8c56-4a18-8330-5b5bb9ac81ed;;;Karina Zygmont;;;;;paczkomat;
dom.dmo@interia.pl;+48502171651;B;SOP06M;3f2ac713-746d-4979-8c4c-ff9ad6cc3d75;;;Dominika Dmochowska;;;;;paczkomat;
rymarczyq@gmail.com;+48790348812;B;KAT55M;d7e09715-ffcf-4471-8a6e-259f77c47d18;;;Anna Rymarczyk;;;;;paczkomat;
badonka@o2.pl;+48606210417;B;POZ282M;353370e5-4259-4b81-baee-faf2a561fb00;;;KAMILA BADOŃ-LEHR;;;;;paczkomat;
zadrozna.karolina@gmail.com;+48605037903;B;LUB117M;8502c7a8-730e-4017-bf9e-cc72fa07432f;;;Karolina Zadrożna;;;;;paczkomat;
i.grenda2005@o2.pl;+48509706676;B;LOD130M;a015f38e-6df9-4e08-b9d7-92e79ee2bbc3;;;Izabela Grenda;;;;;paczkomat;
anetabozyczko@gmail.com;+48502783732;B;SOP02BAPP;013ea1be-1693-4118-a2d9-198458b7fa2d;;;Aneta Bożyczko;;;;;paczkomat;
agfogelman@gmail.com;+48600046865;B;XLT01M;7313df3f-27a3-4ce3-bed5-516767c4b1f1;;;Agata Fogelman-Koscielniak;;;;;paczkomat;
```
