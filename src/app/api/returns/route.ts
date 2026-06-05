import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { createOrderReturn } from '@/lib/return';
import type { StudioReturnConfig, OrderForReturn } from '@/lib/shipx';

export const dynamic = 'force-dynamic';

/**
 * POST /api/returns
 * Body: { order_id: string }
 *
 * Creates an InPost return shipment and emails the customer the return-label PDF.
 * The order UUID acts as a capability token — no login required.
 * Returns 404 for any unknown or ineligible order to avoid order ID enumeration.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : null;
  if (!orderId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const { env } = getCloudflareContext();

  // Assemble studio return config from env — return 503 if not configured.
  const studioConfig = buildStudioReturnConfig(env);
  if (!studioConfig) {
    return NextResponse.json({ error: 'returns_not_configured' }, { status: 503 });
  }

  const supabase = getSupabaseAdmin();

  const result = await createOrderReturn(orderId, {
    loadOrder: async (id) => {
      const { data } = await supabase
        .from('orders')
        .select(
          'id, status, delivery_method, email, receiver_first_name, receiver_last_name, receiver_phone, locale, inpost_return_shipment_id',
        )
        .eq('id', id)
        .maybeSingle();
      return data as (OrderForReturn & {
        status: string;
        delivery_method: string;
        inpost_return_shipment_id: string | null;
      }) | null;
    },
    saveReturn: async (id, d) => {
      // Guard with IS NULL so concurrent requests don't create duplicate ShipX shipments.
      const { error } = await supabase
        .from('orders')
        .update({
          inpost_return_shipment_id: d.returnShipmentId,
          return_requested_at: new Date().toISOString(),
        })
        .eq('id', id)
        .is('inpost_return_shipment_id', null);
      if (error) throw error;
    },
    inpost: getInPost(),
    studioConfig,
  });

  if (!result.ok) {
    // Single opaque body for all ineligible states — distinct reasons in logs only.
    console.info('returns: ineligible', { orderId, reason: result.reason });
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({
    return_shipment_id: result.returnShipmentId,
    tracking_number: result.trackingNumber,
  });
}

function buildStudioReturnConfig(env: CloudflareEnv): StudioReturnConfig | null {
  const first_name = env.STUDIO_RETURN_FIRST_NAME?.trim();
  const last_name = env.STUDIO_RETURN_LAST_NAME?.trim();
  const email = (env.STUDIO_RETURN_EMAIL ?? env.STUDIO_NOTIFY_EMAIL)?.trim();
  const phone = env.STUDIO_RETURN_PHONE?.trim();
  const street = env.STUDIO_RETURN_ADDRESS_STREET?.trim();
  const building = env.STUDIO_RETURN_ADDRESS_BUILDING?.trim();
  const city = env.STUDIO_RETURN_ADDRESS_CITY?.trim();
  const postal = env.STUDIO_RETURN_ADDRESS_POSTAL?.trim();

  const return_point = env.STUDIO_RETURN_POINT?.trim();

  if (!first_name || !last_name || !email || !phone || !street || !building || !city || !postal || !return_point) {
    return null;
  }

  return {
    first_name,
    last_name,
    email,
    phone,
    address: {
      street,
      building_number: building,
      city,
      post_code: postal,
      country_code: 'PL',
    },
    return_point,
  };
}
