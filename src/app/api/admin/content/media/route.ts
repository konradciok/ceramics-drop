import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { validateUpload, uploadKeyFor } from '@/lib/admin/site-media-upload';
import { SITE_MEDIA_PREFIX, siteMediaUrl } from '@/lib/site-media';

export const dynamic = 'force-dynamic';

/**
 * Admin site-media upload — stores homepage-hero images/video into the same
 * R2 bucket + prefix the public `/api/media/[key]` route serves from, keyed
 * by content hash (idempotent re-uploads of identical bytes).
 *
 * This path is auto-gated by Cloudflare Access in production via
 * `ADMIN_PATH_RE` (see `src/lib/admin/access.ts`) — no auth code here.
 */
export async function POST(req: Request) {
  const { env } = getCloudflareContext();

  const url = new URL(req.url);
  const width = Number(url.searchParams.get('width'));
  const height = Number(url.searchParams.get('height'));
  const contentType = req.headers.get('content-type') ?? '';

  const buf = await req.arrayBuffer();

  const validated = validateUpload({
    contentType,
    contentLength: buf.byteLength,
    width,
    height,
    bytes: buf,
  });

  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: validated.status });
  }

  const key = await uploadKeyFor(buf, validated.ext);

  try {
    await env.PRINT_ASSETS.put(SITE_MEDIA_PREFIX + key, buf, {
      httpMetadata: { contentType: validated.contentType },
    });
  } catch {
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }

  return NextResponse.json({
    key,
    contentType: validated.contentType,
    width,
    height,
    url: siteMediaUrl(key),
  });
}
