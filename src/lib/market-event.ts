/* ============================================================
   El Médano handicraft market — one-off campaign landing page
   (`/en/el-medano`, see src/app/[locale]/el-medano/page.tsx).

   Event facts, outbound URLs, the photo sets the page renders and the
   analytics engagement types it emits. All visible copy lives in the
   `market` message namespace: messages/{pl,en,es,de}.json for the four
   site locales, messages/market/{fr,nl,no,sv,cs,sk}.json for the page-only
   languages served at /en/el-medano/<lang> (see src/lib/market-copy.ts).
   ============================================================ */
import type { EditorialImage } from '@/lib/editorial-images';

export const MARKET_PATH = '/el-medano';

/** Site locale whose header/footer shell wraps the page-only languages. */
export const MARKET_SHELL_LOCALE = 'en' as const;

/**
 * Languages the page ships in beyond the four site locales. They are not
 * routable site locales: they live at `/en/el-medano/<lang>` inside the `en`
 * shell and only the page body is translated.
 */
export const MARKET_EXTRA_LANGS = ['fr', 'nl', 'no', 'sv', 'cs', 'sk'] as const;
export type MarketExtraLang = (typeof MARKET_EXTRA_LANGS)[number];

export const MARKET_EVENT = {
  /** Local wall-clock times in `timeZone`, Google Calendar `dates` format. */
  startLocal: '20261010T090000',
  endLocal: '20261010T140000',
  timeZone: 'Atlantic/Canary',
  /** Pin supplied by the studio for the market square. */
  lat: 28.044737720390916,
  lng: -16.538546894694644,
} as const;

/** Event copy from the `market.event` messages, used for the calendar link. */
export type MarketEventCopy = { name: string; place: string; calendarDetails: string; mapLabel: string };

export function marketMapsUrl(): string {
  const query = `${MARKET_EVENT.lat},${MARKET_EVENT.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Google Calendar "add event" template link for the market. */
export function marketCalendarUrl(copy: MarketEventCopy): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: copy.name,
    dates: `${MARKET_EVENT.startLocal}/${MARKET_EVENT.endLocal}`,
    ctz: MARKET_EVENT.timeZone,
    location: `${copy.place}, Tenerife`,
    details: [copy.calendarDetails, `${copy.mapLabel}: ${marketMapsUrl()}`].join(' '),
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

/** Photo shown in the lightbox; its label/caption/alt are `market.photos.<key>.*` messages. */
export type MarketPhoto = { image: EditorialImage };

/** Lookbook row, in display order; the plate-wall band is appended to the same lightbox set. */
export const MARKET_LOOKBOOK: MarketPhoto[] = [
  { image: MARKET_IMAGES.studioSet },
  { image: MARKET_IMAGES.bluePieces },
  { image: MARKET_IMAGES.platesOnPrints },
  { image: MARKET_IMAGES.wallPlates },
];

export const MARKET_PLATE_WALL: MarketPhoto = { image: MARKET_IMAGES.plateWall };

/**
 * Earlier-collection pieces shown in the "From the showroom" gallery — a taste
 * of the style, not a stock list (most are sold). Ids are stable registry ids;
 * image, number and size come from the code registry at render time, and each
 * piece's alt text is a `market.showroom.alt.<id>` message.
 */
export const MARKET_SHOWROOM_IDS = ['k10', 't20', 'h01', 'g01', 's19', 'w08', 'v01', 'd06'] as const;

/** Product photo size by family: mugs and vases are shot portrait, plates and bowls square. */
export function showroomImageSize(category: string): { width: number; height: number } {
  return category === 'kubki' || category.startsWith('wazony')
    ? { width: 1600, height: 2000 }
    : { width: 2000, height: 2000 };
}
