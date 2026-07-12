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
    return {
      ok: false,
      status: 0,
      url: safeUrl,
      contentType: null,
      contentLength: null,
      etag: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const contentType = response.headers.get('content-type');
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
  const etag = response.headers.get('etag');

  if (!response.ok) {
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
