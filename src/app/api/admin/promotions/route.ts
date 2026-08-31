import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { actorEmail, parseJson } from '@/lib/admin/product-routes';
import { listPromotions, createPromotion, promoCreateSchema } from '@/lib/admin/promotions';

export const dynamic = 'force-dynamic';

/**
 * Promotions list + create. Gated by the Cloudflare Access JWT in worker.ts
 * (^/api/admin — no second auth layer here). Thin adapters over
 * src/lib/admin/promotions.ts, matching the print-pricing route shape.
 */

export async function GET() {
  try {
    const promotions = await listPromotions(adminSupabase());
    return NextResponse.json({ promotions });
  } catch (err) {
    console.error('[admin/promotions] list failed', err);
    return NextResponse.json({ error: 'promo_read_failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, promoCreateSchema);
  if (!parsed.ok) return parsed.res;
  const result = await createPromotion(adminSupabase(), parsed.data, actorEmail(req));
  return NextResponse.json(result.body, { status: result.status });
}
