import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { printAssetKey, verifyPrintAssetSig } from '@/lib/print-assets';

export const dynamic = 'force-dynamic';

/** Streams master artwork from R2 to Prodigi, gated by an HMAC-signed URL
    minted in the fulfilment queue consumer (see src/lib/print-assets.ts). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { env } = getCloudflareContext();
  const { id } = await params;

  if (!env.PRINT_ASSET_TOKEN_SECRET || !env.PRINT_ASSETS) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!(await verifyPrintAssetSig(id, exp, sig, env.PRINT_ASSET_TOKEN_SECRET))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const obj = await env.PRINT_ASSETS.get(printAssetKey(id));
  if (!obj) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'content-length': String(obj.size),
      'cache-control': 'private, no-store',
    },
  });
}
