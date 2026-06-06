export const IMG_WIDTHS = [400, 800, 1600] as const;

/** Derives the path for the smallest responsive variant of a base image URL. */
export function smallest(base: string): string {
  const dot = base.lastIndexOf('.');
  if (dot === -1) throw new Error(`smallest() requires a file extension in base path: ${base}`);
  return `${base.slice(0, dot)}-${IMG_WIDTHS[0]}w${base.slice(dot)}`;
}

/**
 * Builds a `srcset` string for the three responsive variants of a base image URL.
 * Example: srcSet('/uploads/kubek-2.webp')
 *   → "/uploads/kubek-2-400w.webp 400w, /uploads/kubek-2-800w.webp 800w, /uploads/kubek-2-1600w.webp 1600w"
 */
export function srcSet(base: string): string {
  const dot = base.lastIndexOf('.');
  if (dot === -1) throw new Error(`srcSet() requires a file extension in base path: ${base}`);
  const stem = base.slice(0, dot);
  const ext = base.slice(dot);
  return IMG_WIDTHS.map((w) => `${stem}-${w}w${ext} ${w}w`).join(', ');
}
