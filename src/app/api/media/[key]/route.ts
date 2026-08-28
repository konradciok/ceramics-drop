import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  SITE_MEDIA_PREFIX,
  SITE_MEDIA_KEY_RE,
  parseRangeHeader,
  siteMediaHeaders,
} from '@/lib/site-media';

export const dynamic = 'force-dynamic';

/** Empty-body response for the small set of non-2xx outcomes this route needs. */
function empty(status: number, extraHeaders?: HeadersInit): Response {
  return new Response(null, { status, headers: extraHeaders });
}

/** Streams a public, unauthenticated CMS site-media asset (homepage hero
    images/video) from R2, with byte-range support for video scrubbing/seek. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { env } = getCloudflareContext();
  const { key } = await params;

  if (!SITE_MEDIA_KEY_RE.test(key)) return empty(404);

  const r2Key = SITE_MEDIA_PREFIX + key;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    let head;
    try {
      head = await env.PRINT_ASSETS.head(r2Key);
    } catch {
      return empty(503);
    }
    if (!head) return empty(404);

    const range = parseRangeHeader(rangeHeader, head.size);
    if (range === 'invalid') {
      return empty(416, { 'content-range': `bytes */${head.size}` });
    }

    if (range) {
      let obj;
      try {
        obj = await env.PRINT_ASSETS.get(r2Key, {
          range: { offset: range.start, length: range.end - range.start + 1 },
        });
      } catch {
        return empty(503);
      }
      if (!obj) return empty(404);

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
    return empty(503);
  }
  if (!obj) return empty(404);

  return new Response(obj.body, { headers: siteMediaHeaders(obj, key) });
}

/** Metadata-only probe (no body) — same validation and headers as GET. */
export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { env } = getCloudflareContext();
  const { key } = await params;

  if (!SITE_MEDIA_KEY_RE.test(key)) return empty(404);

  const r2Key = SITE_MEDIA_PREFIX + key;

  let obj;
  try {
    obj = await env.PRINT_ASSETS.head(r2Key);
  } catch {
    return empty(503);
  }
  if (!obj) return empty(404);

  return new Response(null, { headers: siteMediaHeaders(obj, key) });
}
