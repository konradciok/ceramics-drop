/**
 * M-14: shared redaction for HMAC-signed print-asset URLs. A signed URL is a
 * bearer credential for its TTL — it must never be persisted (DB JSON columns)
 * or logged verbatim. The path + `exp` stay for debuggability; only the secret
 * query params are masked.
 *
 * Moved out of print-asset-smoke.ts (which re-exports it) so the Prodigi
 * callback/merge path can deep-redact persisted payloads without importing the
 * smoke-probe module.
 */

const SECRET_QUERY_PARAMS = ['sig', 'token'];

/** Strip the HMAC signature from a signed URL for operator/CI logs. */
export function redactSignedPrintAssetUrl(url: string): string {
  const parsed = new URL(url);
  for (const param of SECRET_QUERY_PARAMS) {
    if (parsed.searchParams.has(param)) {
      parsed.searchParams.set(param, '[REDACTED]');
    }
  }
  return parsed.toString();
}

const MAX_DEPTH = 32;

/**
 * Deep-copy `value` with every string that looks like a signed URL redacted.
 * Callback payloads echo the asset URL at `items[].assets[].url` (v4 order
 * shape), but Prodigi may add fields — so every string field is checked, not
 * just the documented path. Non-URL strings and strings without a secret query
 * param pass through unchanged. Never throws: on any parse surprise the
 * original value is kept.
 */
export function deepRedactSignedUrls<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value; // defensive: never recurse unboundedly
  if (typeof value === 'string') {
    if (!SECRET_QUERY_PARAMS.some((p) => value.includes(`${p}=`))) return value;
    try {
      return redactSignedPrintAssetUrl(value) as T;
    } catch {
      return value; // not a parseable URL — leave as-is
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepRedactSignedUrls(v, depth + 1)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRedactSignedUrls(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
