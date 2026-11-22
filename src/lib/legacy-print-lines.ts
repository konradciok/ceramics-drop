/* ============================================================
   Legacy fine-art print order lines (read-only history).
   Prints moved to their own shop (PRINT_SHOP_URL, 2026-11) and are no
   longer sold here, but past orders keep `order_items` rows with a
   `variant` jsonb ({ kind: 'print', size, framed, mount, frameColour, … }).
   This module is the frozen, registry-free way to label those lines, so
   order history survives the print registry's removal. Do not grow it:
   it only ever needs to describe orders that already exist.
   ============================================================ */

/** Cart-token prefix every print line used (`print:<design>:<size>:…`). */
export const RETIRED_PRINT_TOKEN_PREFIX = 'print:';

/** A cart token from the retired print shop — never purchasable again. */
export function isRetiredPrintToken(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(RETIRED_PRINT_TOKEN_PREFIX);
}

/** Display names frozen from the print registry at retirement (code curation). */
const LEGACY_PRINT_NAMES: Readonly<Record<string, string>> = {
  fap001: 'Ostrea 01',
  fap002: 'Ostrea 02',
  fap003: 'Ostrea 03',
  fap006: 'Ostrea 04',
  fap007: 'Ostrea 05',
  fap010: 'Gestures 01',
  fap012: 'Gestures 02',
  fap014: 'Gestures 03',
  fap016: 'Gestures 04',
  fap011: 'Gestures 05',
  fap038: 'Gestures 06',
  fap039: 'Gestures 07',
  fap015: 'Gestures 08',
  fap018: 'Linea 01',
  fap036: 'Linea 02',
  fap041: 'Linea 03',
  fap040: 'Linea 04',
  fap035: 'Linea 05',
  fap019: 'Linea 06',
  fap020: 'Linea 07',
  fap021: 'Linea 08',
  fap034: 'Linea 09',
  fap023: 'Horizons 01',
  fap026: 'Horizons 02',
  fap046: 'Cumulonimbus 03',
  fap047: 'Cumulonimbus 06',
  fap024: 'Portals 01',
  fap027: 'Portals 02',
  fap030: 'Portals 03',
  fap031: 'Portals 04',
  fap032: 'Portals 05',
  fap055: 'Unda 04',
  fap056: 'Unda 05',
  fap004: 'Signs 01',
  fap005: 'Signs 02',
  fap008: 'Ciala 01',
  fap033: 'Ciala 02',
  fap028: 'Balance 01',
  fap025: 'Balance 02',
  fap057: 'Tachylite 03',
  fap009: 'Verticles 01',
  fap013: 'Verticles 02',
  fap017: 'Verticles 03',
  fap022: 'Verticles 04',
  fap050: 'Obsidian 02',
  fap051: 'Obsidian 03',
  fap052: 'Obsidian 04',
  fap053: 'Obsidian 05',
  fap042: 'Aurora 01',
  fap043: 'Aurora 02',
  fap044: 'Aurora 04',
  fap045: 'Cirrus 01',
  fap058: 'Cumulus 02',
  fap048: 'Cumulus 01',
  fap049: 'Cumulus 06',
  fap054: 'Scopulus 02',
};

/** True for a bare design id (`fap001`) of the retired print shop, as stored in order_items. */
export function isLegacyPrintId(productId: string): boolean {
  return Object.hasOwn(LEGACY_PRINT_NAMES, productId);
}

/** Localised fallback noun when a design id is not in the frozen table. */
const PRINT_NOUN: Record<string, string> = { pl: 'Odbitka', en: 'Print', es: 'Impresión', de: 'Druck' };

/** Display name for a historical print line, e.g. "Ostrea 01". */
export function legacyPrintName(productId: string, locale: string): string {
  return LEGACY_PRINT_NAMES[productId] ?? `${PRINT_NOUN[locale] ?? PRINT_NOUN.pl} ${productId}`;
}

type LegacySize = '30x40' | '50x70' | '70x100';
type LegacyFrameColour = 'black' | 'natural' | 'brown';

const SIZE_LABEL: Record<LegacySize, string> = {
  '30x40': '30×40 cm',
  '50x70': '50×70 cm',
  '70x100': '70×100 cm',
};
const UNFRAMED_LABEL: Record<string, string> = {
  pl: 'bez ramy', en: 'no frame', es: 'sin marco', de: 'ohne Rahmen',
};
const COLOUR_LABEL: Record<string, Record<LegacyFrameColour, string>> = {
  pl: { black: 'czarna', natural: 'jasnobrązowa', brown: 'ciemnobrązowa' },
  en: { black: 'black', natural: 'light brown', brown: 'dark brown' },
  es: { black: 'negro', natural: 'marrón claro', brown: 'marrón oscuro' },
  de: { black: 'schwarz', natural: 'hellbraun', brown: 'dunkelbraun' },
};
const MOUNT_LABEL: Record<string, string> = {
  pl: '+ passe-partout', en: '+ mount', es: '+ passepartout', de: '+ Passepartout',
};
const FRAME_LABEL: Record<string, string> = {
  pl: 'rama', en: 'frame', es: 'marco', de: 'Rahmen',
};

/**
 * One-line summary of a persisted print `variant` (size · frame · mount), or
 * null when the value is not a recognisable print variant. Defensive: a
 * corrupt or partial jsonb degrades instead of rendering "undefined".
 */
export function formatLegacyPrintVariant(variant: unknown, locale: string): string | null {
  if (typeof variant !== 'object' || variant === null) return null;
  const v = variant as Record<string, unknown>;
  if (typeof v.size !== 'string' || !(v.size in SIZE_LABEL) || typeof v.framed !== 'boolean') return null;
  const loc = locale in COLOUR_LABEL ? locale : 'pl';
  const parts = [SIZE_LABEL[v.size as LegacySize]];
  if (!v.framed) {
    parts.push(UNFRAMED_LABEL[loc]);
  } else {
    const colour =
      typeof v.frameColour === 'string' && v.frameColour in COLOUR_LABEL[loc]
        ? COLOUR_LABEL[loc][v.frameColour as LegacyFrameColour]
        : '';
    parts.push(`${FRAME_LABEL[loc]}${colour ? ` ${colour}` : ''}`);
    if (v.mount === true) parts.push(MOUNT_LABEL[loc]);
  }
  return parts.join(' · ');
}

/**
 * The `size:framed:mount:frameColour` key a print line carried (invoice line
 * metadata, studio emails), or null for a malformed variant. Matches the
 * retired print-cart `variantKey` byte for byte so idempotent invoice reuse
 * keeps recognising lines written before the registry was removed.
 */
export function legacyPrintVariantKey(variant: unknown): string | null {
  if (typeof variant !== 'object' || variant === null) return null;
  const v = variant as Record<string, unknown>;
  if (typeof v.size !== 'string' || typeof v.framed !== 'boolean') return null;
  const mount = v.framed === true && v.mount === true;
  const frameColour = typeof v.frameColour === 'string' ? v.frameColour : 'none';
  return `${v.size}:${v.framed}:${mount}:${frameColour}`;
}

/** The Prodigi SKU snapshotted on a historical print line, or null. */
export function legacyPrintSku(variant: unknown): string | null {
  if (typeof variant !== 'object' || variant === null) return null;
  const sku = (variant as Record<string, unknown>).prodigiSku;
  return typeof sku === 'string' && sku !== '' ? sku : null;
}
