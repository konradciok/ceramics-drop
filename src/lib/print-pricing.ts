import type { PrintSize, PrintVariantSelection } from './types';

type Money = { pln: number; eur: number; gbp: number };

const SIZE_BASE: Record<PrintSize, Money> = {
  '30x40':  { pln: 105, eur: 25, gbp: 22 },
  '50x70':  { pln: 150, eur: 35, gbp: 30 },
  '70x100': { pln: 190, eur: 45, gbp: 38 },
};

// ponytail: zero deltas until studio confirms framing margins
const FRAMED_DELTA: Money = { pln: 0, eur: 0, gbp: 0 };
const MOUNT_DELTA:  Money = { pln: 0, eur: 0, gbp: 0 };

/** Price in MAJOR units (PLN złoty / EUR / GBP). Conversion to minor units at checkout. */
export function priceOfVariant(
  sel: PrintVariantSelection,
  currency: 'pln' | 'eur' | 'gbp',
): number {
  const base  = SIZE_BASE[sel.size];
  const frame = sel.framed ? FRAMED_DELTA : { pln: 0, eur: 0, gbp: 0 };
  const mount = sel.framed && sel.mount ? MOUNT_DELTA : { pln: 0, eur: 0, gbp: 0 };
  if (currency === 'gbp') return base.gbp + frame.gbp + mount.gbp;
  if (currency === 'eur') return base.eur + frame.eur + mount.eur;
  return base.pln + frame.pln + mount.pln;
}
