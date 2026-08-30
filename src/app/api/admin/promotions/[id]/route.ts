import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { actorEmail, parseJson } from '@/lib/admin/product-routes';
import { updatePromotion, promoPatchSchema } from '@/lib/admin/promotions';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

/**
 * Promotion partial update / activation toggle. Cloudflare Access-gated via
 * worker.ts (^/api/admin). The parse layer keeps `code` in the shape so a
 * rename attempt reaches updatePromotion's specific 400 code_immutable; the
 * repository validates the MERGED record's cross-field rules.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const parsed = await parseJson(req, promoPatchSchema);
  if (!parsed.ok) return parsed.res;
  const result = await updatePromotion(adminSupabase(), id, parsed.data, actorEmail(req));
  return NextResponse.json(result.body, { status: result.status });
}
