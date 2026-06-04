import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getInPost } from '@/lib/inpost';
import { emailReturnLabelToCustomer } from '@/lib/email';
import { createOrderReturn } from '@/lib/return';
import type { StudioReturnConfig } from '@/lib/shipx';
import type { OrderForReturn } from '@/lib/shipx';

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
          'id, status, delivery_method, email, receiver_first_name, locale, inpost_return_shipment_id',
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
      const { error } = await supabase
        .from('orders')
        .update({
          inpost_return_shipment_id: d.returnShipmentId,
          return_requested_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
    inpost: getInPost(),
    studioConfig,
    emailReturnLabel: async (order, labelPdf, locale) => {
      await emailReturnLabelToCustomer({ order, labelPdf, locale });
    },
  });

  if (!result.ok) {
    // Return 404 for all ineligible states to avoid leaking order state.
    return NextResponse.json({ error: result.reason }, { status: 404 });
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

  if (!first_name || !last_name || !email || !phone || !street || !building || !city || !postal) {
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
    return_point: env.STUDIO_RETURN_POINT?.trim() || undefined,
  };
}
