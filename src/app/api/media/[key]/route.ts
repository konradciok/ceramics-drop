import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  SITE_MEDIA_PREFIX,
  SITE_MEDIA_KEY_RE,
  parseRangeHeader,
  siteMediaHeaders,
} from '@/lib/site-media';

export const dynamic = 'force-dynamic';

/** JSON error response for the non-2xx outcomes this route needs — matches
    the print-assets template's `{ error }` convention. */
function errorResponse(
  error: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

/** Streams a public, unauthenticated CMS site-media asset (homepage hero
    images/video) from R2, with byte-range support for video scrubbing/seek. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { env } = getCloudflareContext();
  const { key } = await params;

  if (!SITE_MEDIA_KEY_RE.test(key)) return errorResponse('not_found', 404);

  const r2Key = SITE_MEDIA_PREFIX + key;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    let head;
    try {
      head = await env.PRINT_ASSETS.head(r2Key);
    } catch {
      return errorResponse('storage_unavailable', 503);
    }
    if (!head) return errorResponse('not_found', 404);

    const range = parseRangeHeader(rangeHeader, head.size);
    if (range === 'invalid') {
      return errorResponse('range_not_satisfiable', 416, {
        'content-range': `bytes */${head.size}`,
      });
    }

    if (range) {
      let obj;
      try {
        obj = await env.PRINT_ASSETS.get(r2Key, {
          range: { offset: range.start, length: range.end - range.start + 1 },
        });
      } catch {
        return errorResponse('storage_unavailable', 503);
      }
      if (!obj) return errorResponse('not_found', 404);

      return new Response(obj.body, {
        status: 206,
        headers: siteMediaHeaders(obj, key, range),
      });
    }
    // range === null: malformed/unsupported Range header — fall through and
    // serve the whole file with 200, per RFC 9110 (a server MAY ignore it).
  }

  let obj;
  try {
    obj = await env.PRINT_ASSETS.get(r2Key);
  } catch {
    return errorResponse('storage_unavailable', 503);
  }
  if (!obj) return errorResponse('not_found', 404);

  return new Response(obj.body, { headers: siteMediaHeaders(obj, key) });
}

/** Metadata-only probe (no body on success) — same validation and headers
    as GET; error paths share the JSON `{ error }` convention with GET. */
export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { env } = getCloudflareContext();
  const { key } = await params;

  if (!SITE_MEDIA_KEY_RE.test(key)) return errorResponse('not_found', 404);

  const r2Key = SITE_MEDIA_PREFIX + key;

  let obj;
  try {
    obj = await env.PRINT_ASSETS.head(r2Key);
  } catch {
    return errorResponse('storage_unavailable', 503);
  }
  if (!obj) return errorResponse('not_found', 404);

  return new Response(null, { headers: siteMediaHeaders(obj, key) });
}
