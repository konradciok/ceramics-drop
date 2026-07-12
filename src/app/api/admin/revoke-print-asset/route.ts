/* Cloudflare Access-gated admin route: emergency-revoke a print fulfilment asset. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { actorEmail } from '@/lib/admin/product-routes';
import { revokePrintAssetAction } from '@/lib/admin/print-asset-actions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { assetId?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
  if (!assetId) {
    return NextResponse.json({ error: 'asset_id_required' }, { status: 400 });
  }

  try {
    const result = await revokePrintAssetAction(adminSupabase(), assetId, {
      force: body.force === true,
      actorEmail: actorEmail(req),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error('[admin/revoke-print-asset] revoke failed', err);
    return NextResponse.json({ error: 'revoke_failed' }, { status: 500 });
  }
}
