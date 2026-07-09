/* Admin action: end an active drop. Pure bookkeeping — sets the drop's
 * status='ended' + ended_at, and touches NO piece. Retiring pieces into the
 * showroom is a separate, explicit step (toggle-showroom), per the
 * "no automatic mass-move" requirement. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { dropId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const dropId = typeof body.dropId === 'string' ? body.dropId.trim() : '';
  if (!dropId) return NextResponse.json({ error: 'dropId required' }, { status: 400 });

  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('drops')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', dropId)
    .eq('status', 'active')
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Drop nie istnieje lub jest już zakończony.' }, { status: 409 });
  }

  return NextResponse.json({ message: `Drop ${dropId} zakończony.` });
}
