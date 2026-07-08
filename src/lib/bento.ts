/**
 * Deterministic "light bento" rhythm: the first tile is a 2×2 lead; every 7th
 * tile thereafter is a 2×1 wide. Pure and index-based so SSR and client agree.
 * Tunable: change the cadence (7) to taste.
 */
export function featureKind(index: number): 'lead' | 'wide' | undefined {
  if (index === 0) return 'lead';
  if (index % 7 === 0) return 'wide';
  return undefined;
}
