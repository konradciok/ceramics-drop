/* LOCAL-ONLY admin action: retry InPost shipment creation for a paid order.
 * Mirrors the Stripe webhook shipment wiring and keeps the operation idempotent
 * through createOrderShipment's inpost_shipment_id guard. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { getInPost } from '@/lib/inpost';
import { createOrderShipment } from '@/lib/shipment';
import { needsShipment, type OrderForShipment } from '@/lib/shipx';
import type { DeliveryMethod } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

function isDeliveryMethod(method: string | null): method is DeliveryMethod {
  return method === 'paczkomat' || method === 'kurier' || method === 'odbior';
}

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;
  const { orderId } = parsed;

  const supabase = adminSupabase();
  const { data: order, error } = await supabase
    .from('orders')
    .select('payment_intent_id, status, delivery_method, inpost_shipment_id')
    .eq('id', orderId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (order.status !== 'paid') {
    return NextResponse.json({ error: `Nie można utworzyć przesyłki dla zamówienia o statusie „${order.status}”.` }, { status: 409 });
  }
  if (!order.payment_intent_id) {
    return NextResponse.json({ error: 'Brak PaymentIntent dla zamówienia.' }, { status: 409 });
  }
  if (!isDeliveryMethod(order.delivery_method)) {
    return NextResponse.json({ error: 'Nieobsługiwana metoda dostawy.' }, { status: 409 });
  }
  if (!needsShipment(order.delivery_method)) {
    return NextResponse.json({ error: 'Odbiór osobisty nie wymaga przesyłki.' }, { status: 409 });
  }

  const hadShipment = !!order.inpost_shipment_id;

  try {
    await createOrderShipment(order.payment_intent_id, {
      loadOrder: async (paymentIntentId) => {
        const { data } = await supabase
          .from('orders')
          .select(
            'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
              'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
              'inpost_dispatch_order_id',
          )
          .eq('payment_intent_id', paymentIntentId)
          .single();
        return (data as OrderForShipment | null) ?? null;
      },
      saveShipment: async (id, d) => {
        const { error: saveErr } = await supabase
          .from('orders')
          .update({
            inpost_shipment_id: d.shipmentId,
            inpost_tracking_number: d.trackingNumber,
            delivery_status: d.status,
          })
          .eq('id', id)
          .is('inpost_shipment_id', null);
        if (saveErr) throw saveErr;
      },
      saveDispatchOrderId: async (id, dispatchOrderId) => {
        const { error: saveErr } = await supabase
          .from('orders')
          .update({ inpost_dispatch_order_id: dispatchOrderId })
          .eq('id', id)
          .is('inpost_dispatch_order_id', null);
        if (saveErr) throw saveErr;
      },
      inpost: getInPost(),
    });

    return NextResponse.json({ message: hadShipment ? 'Przesyłka już istnieje.' : 'Przesyłka utworzona.' });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'ShipX shipment failed' }, { status: 502 });
  }
}
