/* ============================================================
   Fine-art print cart tokens.
   ------------------------------------------------------------
   The cart stays a flat `string[]` (see src/store/cart.ts). Ceramics are
   bare ids (`k01`); prints are encoded as COMPOSITE TOKENS that carry the
   chosen variant, so the store and most consumers keep the same shape:

     cartToken : `print:<designId>:<size>:<paper>:<frame>`   e.g. print:fap01:a3:satin:oak
     variantKey:               `<size>:<paper>:<frame>`       e.g. a3:satin:oak

   decodePrintToken is the trust boundary: it validates the axis enums, so
   a hand-crafted token can never smuggle an unknown size/paper/frame past
   the server. Pricing/availability happen after, against the design.
   ============================================================ */
import type { PrintFrame, PrintPaper, PrintSize, PrintVariantSelection } from './types';

/** Canonical axis value sets — the runtime source of truth for valid enums. */
export const PRINT_SIZES: readonly PrintSize[] = ['a4', 'a3', 'a2'];
export const PRINT_PAPERS: readonly PrintPaper[] = ['matte', 'satin'];
export const PRINT_FRAMES: readonly PrintFrame[] = ['none', 'oak', 'black'];

const TOKEN_PREFIX = 'print';

/** True when a cart id is a print token (vs a bare ceramic id). */
export function isPrintToken(id: string): boolean {
  return id.startsWith(`${TOKEN_PREFIX}:`);
}

/** Canonical `size:paper:frame` key (used for availability + SKU + override lookup). */
export function variantKey(sel: PrintVariantSelection): string {
  return `${sel.size}:${sel.paper}:${sel.frame}`;
}

/** Encode a design + variant selection into a cart token. */
export function encodePrintToken(designId: string, sel: PrintVariantSelection): string {
  return `${TOKEN_PREFIX}:${designId}:${sel.size}:${sel.paper}:${sel.frame}`;
}

/**
 * Decode + validate a cart token. Returns null for any malformed token or any
 * axis value outside the canonical enums. Does NOT check the design exists or
 * the combination is offered — that is the caller's job (getPrintById +
 * isVariantAvailable), so this stays a pure structural/enum guard.
 */
export function decodePrintToken(
  token: string,
): { designId: string; sel: PrintVariantSelection } | null {
  if (!isPrintToken(token)) return null;
  const parts = token.split(':');
  if (parts.length !== 5) return null;
  const [, designId, size, paper, frame] = parts;
  if (!designId) return null;
  if (!PRINT_SIZES.includes(size as PrintSize)) return null;
  if (!PRINT_PAPERS.includes(paper as PrintPaper)) return null;
  if (!PRINT_FRAMES.includes(frame as PrintFrame)) return null;
  return {
    designId,
    sel: { size: size as PrintSize, paper: paper as PrintPaper, frame: frame as PrintFrame },
  };
}

/* Compact, self-contained labels for the cart + transactional emails. These do
   NOT depend on next-intl so server-side fulfillment (webhook → email/invoice)
   can render a variant without a request context. UI may also use the
   `print.*` i18n keys for richer copy. */
const SIZE_LABEL: Record<PrintSize, string> = { a4: 'A4', a3: 'A3', a2: 'A2' };
const PAPER_LABEL: Record<string, Record<PrintPaper, string>> = {
  pl: { matte: 'mat', satin: 'satyna' },
  en: { matte: 'matte', satin: 'satin' },
  es: { matte: 'mate', satin: 'satinado' },
  de: { matte: 'matt', satin: 'satin' },
  gb: { matte: 'matte', satin: 'satin' },
};
const FRAME_LABEL: Record<string, Record<PrintFrame, string>> = {
  pl: { none: 'bez ramy', oak: 'rama dębowa', black: 'rama czarna' },
  en: { none: 'no frame', oak: 'oak frame', black: 'black frame' },
  es: { none: 'sin marco', oak: 'marco de roble', black: 'marco negro' },
  de: { none: 'ohne Rahmen', oak: 'Eichenrahmen', black: 'Schwarzer Rahmen' },
  gb: { none: 'no frame', oak: 'oak frame', black: 'black frame' },
};

/** Human-readable one-line variant label, e.g. "A3 · satyna · rama dębowa". */
export function variantLabel(sel: PrintVariantSelection, locale: string): string {
  const loc = locale in PAPER_LABEL ? locale : 'pl';
  return [SIZE_LABEL[sel.size], PAPER_LABEL[loc][sel.paper], FRAME_LABEL[loc][sel.frame]].join(' · ');
}
