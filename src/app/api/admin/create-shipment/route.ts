/* LOCAL-ONLY admin action: retry InPost shipment creation for a paid order.
 * Mirrors the Stripe webhook shipment wiring and keeps the operation idempotent
 * through createOrderShipment's inpost_shipment_id guard. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { isUuid } from '@/lib/admin/data';
import { getInPost } from '@/lib/inpost';
import { createOrderShipment } from '@/lib/shipment';
import { ShipxApiError } from '@/lib/shipx-errors';
import { needsShipment, type OrderForShipment } from '@/lib/shipx';
import { countCeramicOrderItems, type CeramicCountClient } from '@/lib/fulfillment';
import type { DeliveryMethod } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

function isDeliveryMethod(method: string | null): method is DeliveryMethod {
  return method === 'paczkomat' || method === 'kurier' || method === 'odbior';
}

function friendlyShipmentError(err: unknown): string {
  if (err instanceof ShipxApiError) {
    if (err.code === 'validation_failed' || err.code === 'offer_expired' || err.code === 'offer_unavailable') {
      return 'Oferta wygasła — użyj „Utwórz nową przesyłkę”.';
    }
    if (err.shipxMessage?.includes('debt_collection') || err.message.includes('debt_collection')) {
      return 'InPost odrzucił zakup (debt_collection) — ureguluj saldo w Managerze Paczek.';
    }
  }
  const msg = err instanceof Error ? err.message : 'ShipX shipment failed';
  if (msg.includes('no buyable offer found')) {
    return 'Brak aktywnej oferty — użyj „Utwórz nową przesyłkę”.';
  }
  return msg;
}

type CreateShipmentBody = { orderId?: string; recreate?: boolean };

export async function POST(req: NextRequest) {
  let body: CreateShipmentBody;
  try {
    body = (await req.json()) as CreateShipmentBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const orderId = body.orderId;
  if (!isUuid(orderId)) {
    return NextResponse.json({ error: 'Valid orderId required' }, { status: 400 });
  }
  const recreate = body.recreate === true;

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

  // Print-only orders (no ceramic line items) are shipped by Prodigi — an
  // InPost shipment for one would be paid for and never used.
  const { count: ceramicCount, error: countErr } = await countCeramicOrderItems(
    supabase as unknown as CeramicCountClient,
    orderId,
  );
  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 });
  if ((ceramicCount ?? 0) === 0) {
    return NextResponse.json(
      { error: 'Zamówienie zawiera tylko druki — wysyłkę realizuje Prodigi, nie InPost.' },
      { status: 409 },
    );
  }

  const hadShipment = !!order.inpost_shipment_id;

  if (recreate) {
    if (!hadShipment) {
      return NextResponse.json({ error: 'Brak przesyłki do zastąpienia.' }, { status: 409 });
    }
    const { error: clearErr } = await supabase
      .from('orders')
      .update({
        inpost_shipment_id: null,
        inpost_tracking_number: null,
        inpost_dispatch_order_id: null,
        delivery_status: null,
        inpost_label_emailed_at: null,
      })
      .eq('id', orderId);
    if (clearErr) return NextResponse.json({ error: clearErr.message }, { status: 500 });
  }

  try {
    await createOrderShipment(
      order.payment_intent_id,
      {
        loadOrder: async (paymentIntentId) => {
          const { data } = await supabase
            .from('orders')
            .select(
              'id, delivery_method, email, receiver_first_name, receiver_last_name, ' +
                'receiver_phone, inpost_target_point, shipping_address, inpost_shipment_id, ' +
                'inpost_dispatch_order_id, delivery_status',
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
      },
      recreate ? { adoptExisting: false } : undefined,
    );

    if (recreate) {
      return NextResponse.json({ message: 'Nowa przesyłka utworzona.' });
    }
    return NextResponse.json({ message: hadShipment ? 'Przesyłka już istnieje.' : 'Przesyłka utworzona.' });
  } catch (e) {
    return NextResponse.json({ error: friendlyShipmentError(e) }, { status: 502 });
  }
}
