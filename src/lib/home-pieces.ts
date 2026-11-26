import type { Product } from '@/lib/types';

/** How many purchasable pieces the home page shows under the hero. */
export const HOME_PIECES_MAX = 8;

/**
 * Picks the home page's "available now" row from the purchasable pieces (in
 * family order, as `summariseCeramicShop` returns them): one piece from each
 * family in turn, so the row shows the range of the drop instead of eight mugs.
 * Within a family the catalogue order is kept. Pure; exported for tests.
 */
export function pickHomePieces(available: Product[], max = HOME_PIECES_MAX): Product[] {
  const byFamily = new Map<string, Product[]>();
  for (const p of available) {
    const queue = byFamily.get(p.category);
    if (queue) queue.push(p);
    else byFamily.set(p.category, [p]);
  }
  const queues = [...byFamily.values()];
  const picked: Product[] = [];
  for (let round = 0; picked.length < max; round++) {
    let tookAny = false;
    for (const queue of queues) {
      if (picked.length >= max) break;
      const p = queue[round];
      if (p) {
        picked.push(p);
        tookAny = true;
      }
    }
    if (!tookAny) break;
  }
  return picked;
}
