import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { loadPrintDesignsFromDb } from '@/lib/catalog/load';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Hard-expire the tagged catalogue cache after an out-of-band database write.
 * The route lives under /api/admin, so worker.ts applies the existing
 * Cloudflare Access JWT gate before this handler can run.
 */
export function POST() {
  try {
    // Next 16 limits updateTag() to Server Actions. Route Handlers use an
    // immediate-expiry profile; unlike "max", the next read blocks on fresh data.
    revalidateTag('catalog', { expire: 0 });
    return NextResponse.json(
      { invalidated: true, tag: 'catalog' },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[admin/catalog-cache] hard invalidation failed', error);
    return NextResponse.json(
      { error: 'catalog_cache_invalidation_failed' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

/**
 * Exercise the same tagged loader used by storefront and checkout accessors.
 * Calling this in a separate request after POST proves the first post-expiry
 * read resolved the migrated database projection, without exposing PII.
 */
export async function GET() {
  try {
    const prints = await loadPrintDesignsFromDb();
    return NextResponse.json(
      {
        prints: prints.map(({ id, num, published }) => ({ id, num, published })),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[admin/catalog-cache] catalog read failed', error);
    return NextResponse.json(
      { error: 'catalog_cache_read_failed' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
