import type { PrintFrameColour, PrintSize, PrintVariantSelection } from './types';

export const PRINT_SIZES: readonly PrintSize[] = ['30x40', '50x70', '70x100'];
export const PRINT_FRAME_COLOURS: readonly PrintFrameColour[] = ['black', 'white', 'natural'];

const TOKEN_PREFIX = 'print';

/** True when a cart id is a print token (vs a bare ceramic id like 'k01'). */
export function isPrintToken(id: string): boolean {
  return id.startsWith(`${TOKEN_PREFIX}:`);
}

/** Canonical key for variant lookup and unavailable-combination checks. */
export function variantKey(sel: PrintVariantSelection): string {
  return `${sel.size}:${sel.framed}:${sel.mount}:${sel.frameColour}`;
}

/**
 * Parse a `variantKey()` string back into a selection. Throws on malformed keys
 * (operator scripts only — checkout uses decodePrintToken).
 */
export function parseVariantKey(key: string): PrintVariantSelection {
  const parts = key.split(':');
  if (parts.length !== 4) throw new Error(`invalid variant key: ${key}`);
  const [size, framedStr, mountStr, frameColour] = parts;
  if (!PRINT_SIZES.includes(size as PrintSize)) throw new Error(`invalid variant key size: ${key}`);
  const framed = framedStr === 'true';
  const mount = mountStr === 'true';
  if (framedStr !== 'true' && framedStr !== 'false') throw new Error(`invalid variant key: ${key}`);
  if (mountStr !== 'true' && mountStr !== 'false') throw new Error(`invalid variant key: ${key}`);
  const validColour =
    frameColour === 'none' ||
    PRINT_FRAME_COLOURS.includes(frameColour as PrintFrameColour);
  if (!validColour) throw new Error(`invalid variant key colour: ${key}`);
  if (!framed && frameColour !== 'none') throw new Error(`invalid variant key: ${key}`);
  if (framed && frameColour === 'none') throw new Error(`invalid variant key: ${key}`);
  if (!framed && mount) throw new Error(`invalid variant key: ${key}`);
  return {
    size: size as PrintSize,
    framed,
    mount,
    frameColour: frameColour as PrintFrameColour | 'none',
  };
}

/**
 * Storefront configurator gate: which button state a print variant is in. Pure
 * + unit-tested because the configurator is a client island and the repo has no
 * DOM render-test harness. Checkout re-resolves the asset and fail-closes
 * regardless — this only moves the "unavailable" signal forward to the PDP.
 * The cart-holds-ceramics rule is handled upstream in the component.
 *
 *   add                — structurally offered, asset ready, not in cart
 *   remove             — already in cart (removal is ALWAYS allowed, even when
 *                        the asset has since become non-usable, so a buyer is
 *                        never trapped with an un-buyable variant)
 *   disabledAsset      — offered but the asset isn't usable right now
 *   disabledStructural — not offered at all (retired / never-sold combination)
 */
export type PrintVariantButtonState = 'add' | 'remove' | 'disabledAsset' | 'disabledStructural';

export function printVariantButtonState(args: {
  structurallyAvailable: boolean;
  usableVariantKeys: string[] | undefined;
  sel: PrintVariantSelection;
  inCart: boolean;
}): PrintVariantButtonState {
  if (args.inCart) return 'remove';
  const assetReady = args.usableVariantKeys == null || args.usableVariantKeys.includes(variantKey(args.sel));
  if (args.structurallyAvailable && assetReady) return 'add';
  return args.structurallyAvailable ? 'disabledAsset' : 'disabledStructural';
}

/** Encode a variant selection into a cart token. */
export function encodePrintToken(designId: string, sel: PrintVariantSelection): string {
  return `${TOKEN_PREFIX}:${designId}:${sel.size}:${sel.framed}:${sel.mount}:${sel.frameColour}`;
}

/**
 * Decode and validate a cart token. Returns null for any malformed token or
 * unknown axis value. Does NOT check design existence or combination availability
 * — that's the caller's job (getPrintById + isVariantAvailable).
 */
export function decodePrintToken(
  token: string,
): { designId: string; sel: PrintVariantSelection } | null {
  if (!isPrintToken(token)) return null;
  const parts = token.split(':');
  if (parts.length !== 6) return null;
  const [, designId, size, framedStr, mountStr, frameColour] = parts;
  if (!designId) return null;
  if (!PRINT_SIZES.includes(size as PrintSize)) return null;
  const framed = framedStr === 'true';
  const mount = mountStr === 'true';
  if (framedStr !== 'true' && framedStr !== 'false') return null;
  if (mountStr !== 'true' && mountStr !== 'false') return null;
  const validColour =
    frameColour === 'none' ||
    PRINT_FRAME_COLOURS.includes(frameColour as PrintFrameColour);
  if (!validColour) return null;
  if (!framed && frameColour !== 'none') return null;
  if (framed && frameColour === 'none') return null;
  if (!framed && mount) return null; // passe-partout only exists inside a frame
  return {
    designId,
    sel: {
      size: size as PrintSize,
      framed,
      mount,
      frameColour: frameColour as PrintFrameColour | 'none',
    },
  };
}

// ── Human-readable labels ────────────────────────────────────────────────────

const SIZE_LABEL: Record<PrintSize, string> = {
  '30x40': '30×40 cm',
  '50x70': '50×70 cm',
  '70x100': '70×100 cm',
};

const UNFRAMED_LABEL: Record<string, string> = {
  pl: 'bez ramy', en: 'no frame', es: 'sin marco', de: 'ohne Rahmen', gb: 'no frame',
};

const COLOUR_LABEL: Record<string, Record<PrintFrameColour, string>> = {
  pl: { black: 'czarna', white: 'biała', natural: 'naturalna' },
  en: { black: 'black', white: 'white', natural: 'natural' },
  es: { black: 'negro', white: 'blanco', natural: 'natural' },
  de: { black: 'schwarz', white: 'weiß', natural: 'natur' },
  gb: { black: 'black', white: 'white', natural: 'natural' },
};

const MOUNT_LABEL: Record<string, string> = {
  pl: '+ passe-partout', en: '+ mount', es: '+ passepartout',
  de: '+ Passepartout', gb: '+ mount',
};

const FRAME_LABEL: Record<string, string> = {
  pl: 'rama', en: 'frame', es: 'marco', de: 'Rahmen', gb: 'frame',
};

/** One-line variant label for cart, emails, invoice. No i18n runtime needed. */
export function variantLabel(sel: PrintVariantSelection, locale: string): string {
  const loc = locale in COLOUR_LABEL ? locale : 'pl';
  const parts = [SIZE_LABEL[sel.size]];
  if (!sel.framed) {
    parts.push(UNFRAMED_LABEL[loc]);
  } else {
    const colour = sel.frameColour !== 'none' ? COLOUR_LABEL[loc][sel.frameColour] : '';
    parts.push(`${FRAME_LABEL[loc]}${colour ? ` ${colour}` : ''}`);
    if (sel.mount) parts.push(MOUNT_LABEL[loc]);
  }
  return parts.join(' · ');
}

// ── Prodigi SKU lookup (from prodigi/sku-catalog.md) ─────────────────────────

/** Authoritative mapping from variantKey → Prodigi SKU + print-area pixels at 300 DPI. */
export const PRODIGI_SKU_MAP: Record<string, { sku: string; printAreaPx: { w: number; h: number } }> = {
  '30x40:false:false:none':    { sku: 'GLOBAL-FAP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:false:black':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3614, h: 4795 } },
  '30x40:true:false:white':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3614, h: 4795 } },
  '30x40:true:false:natural':  { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:true:black':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:white':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:natural':   { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '50x70:false:false:none':    { sku: 'GLOBAL-FAP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:black':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:white':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:natural':  { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:true:black':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:white':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:natural':   { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '70x100:false:false:none':   { sku: 'GLOBAL-FAP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:black':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:white':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:natural': { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:true:black':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:white':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:natural':  { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
};
