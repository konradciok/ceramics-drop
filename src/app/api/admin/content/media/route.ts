import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  validateUpload,
  uploadKeyFor,
  MAX_VIDEO_BYTES,
  HERO_DESKTOP_MAX_BYTES,
  HERO_MOBILE_MAX_BYTES,
} from '@/lib/admin/site-media-upload';
import { SITE_MEDIA_PREFIX, siteMediaUrl } from '@/lib/site-media';

export const dynamic = 'force-dynamic';

/** Hero-slot LCP budgets (SEO-006), keyed by the `?slot=` param the client
    sends. A poster upload reuses its parent slot's budget. A Map (not a
    plain object) so an inherited property name like `toString` or
    `constructor` can never resolve to a truthy value and silently bypass
    the invalid-slot rejection below. */
const SLOT_BUDGET_BYTES = new Map<string, number>([
  ['desktop', HERO_DESKTOP_MAX_BYTES],
  ['mobile', HERO_MOBILE_MAX_BYTES],
]);

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

  const slot = url.searchParams.get('slot');
  const budgetBytes = slot === null ? undefined : SLOT_BUDGET_BYTES.get(slot);
  if (slot !== null && budgetBytes === undefined) {
    return NextResponse.json({ error: 'invalid_slot' }, { status: 400 });
  }

  // Reject an oversized body BEFORE buffering it into memory — the
  // content-length header can lie, so `validateUpload`'s buffered size check
  // below still stands as the authoritative gate, but a huge declared size
  // should never reach `req.arrayBuffer()` in the first place.
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const buf = await req.arrayBuffer();

  const validated = validateUpload({
    contentType,
    contentLength: buf.byteLength,
    width,
    height,
    bytes: buf,
    budgetBytes,
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
