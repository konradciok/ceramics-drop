/**
 * Read a request body as text, stopping once it exceeds `maxBytes` — so an
 * unauthenticated sender cannot make a webhook buffer an arbitrarily large
 * body before its signature is checked. A declared Content-Length over the
 * limit is refused up front, but the byte count is what is enforced (the
 * header can be absent or wrong). Returns null when the limit is exceeded.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
