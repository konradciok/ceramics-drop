type HeaderReq = { headers: { get(name: string): string | null } };

/**
 * Extract the client IP. On Cloudflare only `cf-connecting-ip` is trustworthy;
 * `x-forwarded-for` is client-spoofable when the request doesn't pass through
 * Cloudflare, so it is only honoured when `trustForwarded` is set (local dev).
 */
export function getClientIp(req: HeaderReq, opts: { trustForwarded?: boolean } = {}): string | null {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;

  if (opts.trustForwarded) {
    const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }

  return null;
}
