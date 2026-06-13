// One-off: inject fine-art-prints i18n keys into messages/{pl,en,es}.json,
// preserving CRLF + 2-space formatting (files are canonical JSON). Idempotent.
import fs from 'node:fs';

const DATA = {
  pl: {
    nav: 'Printy',
    title: 'Printy fine art',
    meta: 'Reprodukcje fine art prac Anny Ciok — druk giclée na papierze archiwalnym. Wybierz rozmiar, papier i oprawę.',
    collection: {
      eyebrow: 'Reprodukcje fine art',
      title: 'Printy <em>fine art</em>',
      lead: 'Druk giclée na papierze archiwalnym. Każdy projekt dostępny w kilku rozmiarach, na wybranym papierze, z oprawą lub bez.',
    },
    notes: [
      'Pierwszy projekt z serii fine art — reprodukcja autorskiej kompozycji w stonowanej palecie.',
      'Drugi projekt z serii — wyrazista forma i ręcznie malowane detale przeniesione na papier archiwalny.',
      'Trzeci projekt z serii fine art.',
    ],
    product: 'Print',
    print: {
      from: 'od {price}',
      axis: { size: 'Rozmiar', paper: 'Papier', frame: 'Oprawa' },
      size: { a4: 'A4', a3: 'A3', a2: 'A2' },
      sizeHint: { a4: '21 × 29,7 cm', a3: '29,7 × 42 cm', a2: '42 × 59,4 cm' },
      paper: { matte: 'Matowy', satin: 'Satynowy' },
      frame: { none: 'Bez ramy', oak: 'Rama dębowa', black: 'Rama czarna' },
      addToCart: 'Dodaj do koszyka',
      inCart: 'W koszyku',
      unavailable: 'Niedostępne w tej kombinacji',
      priceLabel: 'Cena',
      sectionDetails: 'Szczegóły',
      sectionEdition: 'Edycja',
      sectionDelivery: 'Dostawa i realizacja',
      sectionCare: 'Pielęgnacja',
      editionOpen: 'Edycja otwarta — druk na zamówienie.',
      technique: 'Druk giclée, atramenty pigmentowe, papier archiwalny.',
      deliveryNote: 'Druk na zamówienie — realizacja do 7–10 dni roboczych. Oprawione printy wysyłamy kurierem.',
      careNote: 'Chroń przed bezpośrednim słońcem i wilgocią. Najlepiej eksponować w oprawie pod szkłem.',
      moreFrom: 'Więcej z kolekcji printów',
    },
  },
  en: {
    nav: 'Prints',
    title: 'Fine-art prints',
    meta: "Fine-art reproductions of Anna Ciok's work — giclée printed on archival paper. Choose size, paper and framing.",
    collection: {
      eyebrow: 'Fine-art reproductions',
      title: 'Fine-art <em>prints</em>',
      lead: 'Giclée printed on archival paper. Each design comes in several sizes, on the paper you choose, framed or unframed.',
    },
    notes: [
      'The first design in the fine-art series — a reproduction of an original composition in a muted palette.',
      'The second design — a bold form with hand-painted detail, brought to archival paper.',
      'The third design in the fine-art series.',
    ],
    product: 'Print',
    print: {
      from: 'from {price}',
      axis: { size: 'Size', paper: 'Paper', frame: 'Framing' },
      size: { a4: 'A4', a3: 'A3', a2: 'A2' },
      sizeHint: { a4: '21 × 29.7 cm', a3: '29.7 × 42 cm', a2: '42 × 59.4 cm' },
      paper: { matte: 'Matte', satin: 'Satin' },
      frame: { none: 'No frame', oak: 'Oak frame', black: 'Black frame' },
      addToCart: 'Add to cart',
      inCart: 'In cart',
      unavailable: 'Not available in this combination',
      priceLabel: 'Price',
      sectionDetails: 'Details',
      sectionEdition: 'Edition',
      sectionDelivery: 'Delivery & lead time',
      sectionCare: 'Care',
      editionOpen: 'Open edition — printed to order.',
      technique: 'Giclée print, pigment inks, archival paper.',
      deliveryNote: 'Printed to order — made within 7–10 business days. Framed prints ship by courier.',
      careNote: 'Keep away from direct sunlight and damp. Best displayed framed under glass.',
      moreFrom: 'More from the prints collection',
    },
  },
  es: {
    nav: 'Láminas',
    title: 'Láminas fine art',
    meta: 'Reproducciones fine art de la obra de Anna Ciok — impresión giclée en papel de archivo. Elige tamaño, papel y marco.',
    collection: {
      eyebrow: 'Reproducciones fine art',
      title: 'Láminas <em>fine art</em>',
      lead: 'Impresión giclée en papel de archivo. Cada diseño en varios tamaños, en el papel que elijas, con marco o sin él.',
    },
    notes: [
      'El primer diseño de la serie fine art — reproducción de una composición original en una paleta sobria.',
      'El segundo diseño — una forma expresiva con detalle pintado a mano, llevada al papel de archivo.',
      'El tercer diseño de la serie fine art.',
    ],
    product: 'Lámina',
    print: {
      from: 'desde {price}',
      axis: { size: 'Tamaño', paper: 'Papel', frame: 'Marco' },
      size: { a4: 'A4', a3: 'A3', a2: 'A2' },
      sizeHint: { a4: '21 × 29,7 cm', a3: '29,7 × 42 cm', a2: '42 × 59,4 cm' },
      paper: { matte: 'Mate', satin: 'Satinado' },
      frame: { none: 'Sin marco', oak: 'Marco de roble', black: 'Marco negro' },
      addToCart: 'Añadir al carrito',
      inCart: 'En el carrito',
      unavailable: 'No disponible en esta combinación',
      priceLabel: 'Precio',
      sectionDetails: 'Detalles',
      sectionEdition: 'Edición',
      sectionDelivery: 'Envío y plazo',
      sectionCare: 'Cuidado',
      editionOpen: 'Edición abierta — impresión bajo pedido.',
      technique: 'Impresión giclée, tintas pigmentadas, papel de archivo.',
      deliveryNote: 'Impresión bajo pedido — lista en 7–10 días hábiles. Las láminas enmarcadas se envían por mensajería.',
      careNote: 'Protégela de la luz solar directa y la humedad. Mejor expuesta enmarcada bajo cristal.',
      moreFrom: 'Más de la colección de láminas',
    },
  },
};

for (const loc of ['pl', 'en', 'es']) {
  const p = `messages/${loc}.json`;
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const m = JSON.parse(raw);
  const d = DATA[loc];

  m.nav.fineArtPrints = d.nav;
  m.title.fineArtPrints = d.title;
  m.meta.collections.fineArtPrints = d.meta;
  m.collection['fine-art-prints'] = d.collection;
  m.notes['fine-art-prints'] = d.notes;
  m.product.print = d.product;
  m.print = d.print;

  const out = JSON.stringify(m, null, 2).replace(/\n/g, eol) + eol;
  fs.writeFileSync(p, out, 'utf8');
  console.log(`updated ${p}`);
}
