/* ============================================================
   El Médano handicraft market — one-off campaign landing page
   (`/en/el-medano`, see src/app/[locale]/el-medano/page.tsx).

   Event facts, outbound URLs, the photo sets the page renders and the
   analytics engagement types it emits. English-only by design: the page
   serves the `en` locale and every other locale redirects to it, so its
   copy lives here instead of the four-locale message files.
   ============================================================ */
import type { EditorialImage } from '@/lib/editorial-images';

export const MARKET_PATH = '/el-medano';

/** The only locale the landing page renders in; the others redirect here. */
export const MARKET_LOCALE = 'en' as const;

export const MARKET_EVENT = {
  name: 'Anna Ciok at the El Médano handicraft market',
  dateLabel: 'Saturday 10 October 2026',
  shortDateLabel: 'Sat 10 Oct',
  timeLabel: '9:00 – 14:00',
  /** Local wall-clock times in `timeZone`, Google Calendar `dates` format. */
  startLocal: '20261010T090000',
  endLocal: '20261010T140000',
  timeZone: 'Atlantic/Canary',
  place: 'Main plaza, El Médano',
  area: 'Granadilla de Abona, Tenerife',
  /** Pin supplied by the studio for the market square. */
  lat: 28.044737720390916,
  lng: -16.538546894694644,
  payment: 'Cash, card or Bizum',
} as const;

export function marketMapsUrl(): string {
  const query = `${MARKET_EVENT.lat},${MARKET_EVENT.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Google Calendar "add event" template link for the market. */
export function marketCalendarUrl(): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: MARKET_EVENT.name,
    dates: `${MARKET_EVENT.startLocal}/${MARKET_EVENT.endLocal}`,
    ctz: MARKET_EVENT.timeZone,
    location: `${MARKET_EVENT.place}, Tenerife`,
    details: [
      'Hand-painted ceramics and fine art prints by Anna Ciok.',
      `${MARKET_EVENT.payment}.`,
      `Map: ${marketMapsUrl()}`,
    ].join(' '),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * `site_engagement` types the page pushes (docs/analytics-stack.md). They ride
 * the existing GTM `site_engagement` → GA4 + Meta `SiteEngagement` routing, so
 * no container change is needed. `directions` is the campaign's main conversion.
 */
export const MARKET_ENGAGEMENT = {
  directions: 'market_get_directions',
  calendar: 'market_add_to_calendar',
  photoView: 'market_photo_view',
  outbound: 'market_outbound_click',
} as const;

export type MarketEngagementType = (typeof MARKET_ENGAGEMENT)[keyof typeof MARKET_ENGAGEMENT];

export const MARKET_IMAGES = {
  printsPlate: { key: 'printsPlate', src: '/uploads/el-medano-prints-plate.webp', width: 1500, height: 2000 },
  palmVases: { key: 'palmVases', src: '/uploads/el-medano-palm-vases.webp', width: 760, height: 901 },
  framedPrints: { key: 'framedPrints', src: '/uploads/el-medano-framed-prints.webp', width: 1086, height: 1448 },
  annaPlates: { key: 'annaPlates', src: '/uploads/el-medano-anna-plates.webp', width: 1122, height: 1402 },
  studioSet: { key: 'studioSet', src: '/uploads/el-medano-studio-set.webp', width: 1122, height: 1402 },
  bluePieces: { key: 'bluePieces', src: '/uploads/el-medano-blue-pieces.webp', width: 1086, height: 1448 },
  platesOnPrints: { key: 'platesOnPrints', src: '/uploads/el-medano-plates-on-prints.webp', width: 1086, height: 1448 },
  wallPlates: { key: 'wallPlates', src: '/uploads/el-medano-wall-plates.webp', width: 1086, height: 1448 },
  plateWall: { key: 'plateWall', src: '/uploads/el-medano-plate-wall.webp', width: 1086, height: 1448 },
} as const satisfies Record<string, EditorialImage>;

export type MarketPhoto = {
  image: EditorialImage;
  label: string;
  caption: string;
  alt: string;
};

/** Lookbook row, in display order; the plate-wall band is appended to the same lightbox set. */
export const MARKET_LOOKBOOK: MarketPhoto[] = [
  {
    image: MARKET_IMAGES.studioSet,
    label: 'Black & terracotta',
    caption: 'A hat-figure plate, a wave vase and two palm mugs.',
    alt: 'A plate with a figure in a wide-brimmed hat, a vase with a black wave and two palm mugs on stone plinths',
  },
  {
    image: MARKET_IMAGES.bluePieces,
    label: 'In blue',
    caption: 'Graters, hand dishes, a cup and a plate.',
    alt: 'Blue hand-painted ceramic graters, two hand-shaped dishes, a wave cup and a wave plate on a cream plaster wall',
  },
  {
    image: MARKET_IMAGES.platesOnPrints,
    label: 'Clay & paper',
    caption: 'Mermaids, sailors and Fuerte Piba — on plates and on prints.',
    alt: 'Hand-painted plates with a mermaid, sailors and a woman in a wide-brimmed hat laid on Fuerte Piba and Islas Canarias prints on a wooden table',
  },
  {
    image: MARKET_IMAGES.wallPlates,
    label: 'On the wall',
    caption: 'Leaves, a wave and a palm, hung as a small gallery.',
    alt: 'Three hand-painted plates hung on a textured cream wall: terracotta leaves, a black wave with a terracotta sun, and a terracotta palm inside a black scalloped rim',
  },
];

export const MARKET_PLATE_WALL: MarketPhoto = {
  image: MARKET_IMAGES.plateWall,
  label: 'No two alike',
  caption: 'A whole table of plates, every one painted by hand.',
  alt: 'Dozens of hand-painted plates in black and terracotta laid out together in the sun: palms, mermaids, hands, shells, leaves and checks',
};

/**
 * Earlier-collection pieces shown in the "From the showroom" gallery — a taste
 * of the style, not a stock list (most are sold). Ids are stable registry ids;
 * image, number and size come from the code registry at render time.
 */
export const MARKET_SHOWROOM_IDS = ['k10', 't20', 'h01', 'g01', 's19', 'w08', 'v01', 'd06'] as const;

/** Product photo size by family: mugs and vases are shot portrait, plates and bowls square. */
export function showroomImageSize(category: string): { width: number; height: number } {
  return category === 'kubki' || category.startsWith('wazony')
    ? { width: 1600, height: 2000 }
    : { width: 2000, height: 2000 };
}

/** Per-piece alt text (the registry has no descriptive alt for ceramics). */
export const MARKET_SHOWROOM_ALT: Record<(typeof MARKET_SHOWROOM_IDS)[number], string> = {
  k10: 'hand-painted with a blue shell',
  t20: 'a black cactus inside a terracotta rim',
  h01: 'painted inside with two black palm trees',
  g01: 'a black palm tree between terracotta borders',
  s19: 'a black donkey inside a terracotta scalloped rim',
  w08: 'painted with soft blue cacti and terracotta dots',
  v01: 'a blue cactus and a terracotta sun',
  d06: 'a black lobster drawn around the body',
};
