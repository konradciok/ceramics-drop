/** Steps a gallery index by `delta`, clamping at the bounds instead of wrapping. */
export function stepGalleryIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), length - 1);
}
