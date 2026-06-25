/* LOCAL-ONLY admin action: re-send the customer order-confirmation email,
 * reusing the storefront's `emailOrderConfirmationToCustomer`. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { emailOrderConfirmationToCustomer } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;
  const { orderId } = parsed;

  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('id, email, receiver_first_name, locale')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!data.email) return NextResponse.json({ error: 'Zamówienie nie ma adresu e-mail.' }, { status: 409 });

  try {
    await emailOrderConfirmationToCustomer({
      order: { id: data.id, email: data.email, receiver_first_name: data.receiver_first_name },
      locale: data.locale ?? 'pl',
    });
    return NextResponse.json({ message: `Potwierdzenie wysłane ponownie na ${data.email}.` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Wysyłka nie powiodła się' }, { status: 502 });
  }
}
