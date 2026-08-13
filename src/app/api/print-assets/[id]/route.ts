import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { verifyPrintAssetSig } from '@/lib/print-assets';
import { resolveAssetR2Key } from '@/server/print-assets/repository';

export const dynamic = 'force-dynamic';

type ResolvedAsset = {
  r2Key: string;
  contentType: 'image/jpeg' | 'image/png';
};

type AuthResult =
  | { ok: true; asset: ResolvedAsset }
  | { ok: false; response: NextResponse };

async function authorizeAndResolve(
  req: Request,
  assetId: string,
  env: CloudflareEnv,
): Promise<AuthResult> {
  if (!env.PRINT_ASSET_TOKEN_SECRET || !env.PRINT_ASSETS) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unavailable' }, { status: 503 }),
    };
  }

  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!(await verifyPrintAssetSig(assetId, exp, sig, env.PRINT_ASSET_TOKEN_SECRET))) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }

  let resolved;
  try {
    resolved = await resolveAssetR2Key(assetId);
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unavailable' }, { status: 503 }),
    };
  }

  if (resolved.kind === 'revoked') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'gone' }, { status: 410 }),
    };
  }
  if (resolved.kind === 'not_found') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'not_found' }, { status: 404 }),
    };
  }

  return {
    ok: true,
    asset: {
      r2Key: resolved.r2Key,
      contentType: resolved.contentType,
    },
  };
}

function assetHeaders(
  obj: { size: number; httpEtag: string; httpMetadata?: { contentType?: string } },
  contentType: 'image/jpeg' | 'image/png' | null | undefined,
): Headers {
  const headers = new Headers({
    // L-24: the DB-validated content-type column wins; R2 httpMetadata (set at
    // upload time, unvalidated at read) is only the fallback when the column
    // is somehow absent.
    'content-type': contentType ?? obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-length': String(obj.size),
    etag: obj.httpEtag,
    'cache-control': 'private, no-store',
  });
  return headers;
}

/** Streams a snapshotted fulfilment asset from R2 to Prodigi, gated by an
    HMAC-signed URL minted in the fulfilment queue consumer (see src/lib/print-assets.ts). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { env } = getCloudflareContext();
  const { id: assetId } = await params;

  const auth = await authorizeAndResolve(req, assetId, env);
  if (!auth.ok) return auth.response;

  let obj;
  try {
    obj = await env.PRINT_ASSETS!.get(auth.asset.r2Key);
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (!obj) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new Response(obj.body, { headers: assetHeaders(obj, auth.asset.contentType) });
}

/** Metadata-only probe for Prodigi verification (no body). */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { env } = getCloudflareContext();
  const { id: assetId } = await params;

  const auth = await authorizeAndResolve(req, assetId, env);
  if (!auth.ok) return auth.response;

  let obj;
  try {
    obj = await env.PRINT_ASSETS!.head(auth.asset.r2Key);
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (!obj) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new Response(null, { headers: assetHeaders(obj, auth.asset.contentType) });
}
