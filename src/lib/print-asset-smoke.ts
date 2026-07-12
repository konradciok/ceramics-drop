/** Safe logging + HEAD probe for HMAC-signed print-asset URLs. Never log `sig`. */

export type HeadProbeResult =
  | {
      ok: true;
      status: number;
      url: string;
      contentType: string;
      contentLength: number;
      etag: string | null;
    }
  | {
      ok: false;
      status: number;
      url: string;
      contentType: string | null;
      contentLength: number | null;
      etag: string | null;
      error?: string;
    };

/** Strip the HMAC signature from a signed URL for operator/CI logs. */
export function redactSignedPrintAssetUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('sig')) {
    parsed.searchParams.set('sig', '[REDACTED]');
  }
  return parsed.toString();
}

/** HEAD a signed print-asset URL; result URL is always redacted. */
export async function probeSignedPrintAssetHead(
  signedUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<HeadProbeResult> {
  const safeUrl = redactSignedPrintAssetUrl(signedUrl);
  let response: Response;
  try {
    response = await fetchFn(signedUrl, { method: 'HEAD' });
  } catch (e) {
    // Some runtimes embed the request URL verbatim in network-error messages
    // (e.g. Node's "Failed to parse URL from <url>") — scrub it so `sig` never
    // reaches a log/JSON report via the error string.
    const rawMessage = e instanceof Error ? e.message : String(e);
    const message = rawMessage.split(signedUrl).join(safeUrl);
    return {
      ok: false,
      status: 0,
      url: safeUrl,
      contentType: null,
      contentLength: null,
      etag: null,
      error: message,
    };
  }

  const contentType = response.headers.get('content-type');
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
  const etag = response.headers.get('etag');

  // The route contract (`src/app/api/print-assets/[id]/route.ts`) always
  // returns exactly 200 on success — treat any other status as a failure,
  // not just non-2xx (`response.ok` would accept 201/206).
  if (response.status !== 200) {
    return {
      ok: false,
      status: response.status,
      url: safeUrl,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      etag,
    };
  }

  if (!contentType || contentLength === null || !Number.isFinite(contentLength)) {
    return {
      ok: false,
      status: response.status,
      url: safeUrl,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      etag,
      error: 'missing content-type or content-length on 200 HEAD',
    };
  }

  return {
    ok: true,
    status: response.status,
    url: safeUrl,
    contentType,
    contentLength,
    etag,
  };
}
