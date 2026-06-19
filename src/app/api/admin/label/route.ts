/* LOCAL-ONLY admin action: stream the InPost A6 shipping-label PDF for an
 * order's existing shipment, reusing the storefront ShipX client. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { isUuid } from '@/lib/admin/data';
import { getInPost } from '@/lib/inpost';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get('orderId');
  if (!isUuid(orderId)) return NextResponse.json({ error: 'Valid orderId required' }, { status: 400 });

  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('inpost_shipment_id')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!data.inpost_shipment_id) {
    return NextResponse.json({ error: 'Brak przesyłki InPost dla zamówienia.' }, { status: 409 });
  }

  try {
    const pdf = await getInPost().getLabelPdf(data.inpost_shipment_id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="label-${data.inpost_shipment_id}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Label fetch failed' }, { status: 502 });
  }
}
