/** Prodigi order-item attributes for a print variant (frame colour, mount). */
export function buildProdigiAttributes(
  sel: { framed: boolean; mount: boolean; frameColour: string },
): Record<string, string> {
  if (!sel.framed) return {};
  const attrs: Record<string, string> = { color: sel.frameColour };
  if (sel.mount) {
    attrs['mount'] = '2.4mm';
    attrs['mountColor'] = 'Snow white';
  }
  return attrs;
}
