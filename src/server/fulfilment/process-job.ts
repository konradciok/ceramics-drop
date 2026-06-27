import { getSupabaseAdmin } from '@/lib/supabase';
import { prodigiClient, ProdigiError } from '../prodigi/client';
import { buildProdigiPayload } from '../prodigi/mapper';
import type { CloudflareEnv } from '../../../cloudflare-env';
import type { FulfilmentJobMessage } from '../prodigi/types';

async function getAssetUrl(
  productId: string,
  jobId: string,
  env: CloudflareEnv,
): Promise<string> {
  if (!env.PRINT_ASSETS) {
    // Local dev fallback — public SVG placeholder
    return `https://anna-ciok.studio/uploads/${productId}.svg`;
  }
  // R2 presigned GET; key convention: {productId}/master.jpg
  const obj = await env.PRINT_ASSETS.createSignedUrl(
    `${productId}/master.jpg`,
    { expiresIn: 60 * 60 * 24 * 7 }, // 7 days
  );
  return obj.url;
}

export async function processJob(
  msg: FulfilmentJobMessage,
  env: CloudflareEnv,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: ExecutionContext,
): Promise<void> {
  const { orderId, jobId } = msg;
  const supabase = getSupabaseAdmin();

  // 1. Check job is still queued (guard against duplicate queue delivery).
  const { data: job } = await supabase
    .from('fulfilment_jobs')
    .select('status, attempts')
    .eq('id', jobId)
    .single();

  if (!job || !['queued', 'failed_retryable'].includes(job.status)) return;

  // 2. Load order.
  const { data: order } = await supabase
    .from('orders')
    .select('id, status, currency, contact, shipping_address, delivery_method')
    .eq('id', orderId)
    .single();

  if (!order || order.status !== 'paid') {
    await supabase.from('fulfilment_jobs')
      .update({ status: 'failed_action_required', last_error: 'order not paid', updated_at: new Date().toISOString() })
      .eq('id', jobId);
    return;
  }

  // 3. Load print line items.
  const { data: items } = await supabase
    .from('order_items')
    .select('product_id, unit_price, variant')
    .eq('order_id', orderId)
    .not('variant', 'is', null);

  if (!items || items.length === 0) {
    await supabase.from('fulfilment_jobs')
      .update({ status: 'failed_action_required', last_error: 'no print items found', updated_at: new Date().toISOString() })
      .eq('id', jobId);
    return;
  }

  // 4. Mark submitting.
  await supabase.from('fulfilment_jobs')
    .update({ status: 'fulfilment_submitting', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  // 5. Generate asset URLs.
  const assetUrls: Record<string, string> = {};
  for (const item of items) {
    assetUrls[item.product_id] = await getAssetUrl(item.product_id, jobId, env);
  }

  // 6. Build and POST Prodigi order.
  const client = prodigiClient(env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = buildProdigiPayload(order as any, items as any, assetUrls, env);

  let prodigiOrderId: string;
  try {
    const res = await client.postOrder(payload);
    prodigiOrderId = res.order.id;
  } catch (e) {
    const retryable = e instanceof ProdigiError ? e.retryable : true;
    await supabase.from('fulfilment_jobs')
      .update({
        status: retryable ? 'failed_retryable' : 'failed_action_required',
        last_error: String(e),
        attempts: (job.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    if (retryable) throw e; // Causes queue to retry.
    return;
  }

  // 7. Persist Prodigi order + mark submitted.
  await supabase.from('prodigi_orders').upsert(
    { order_id: orderId, prodigi_order_id: prodigiOrderId, prodigi_status_stage: 'InProgress' },
    { onConflict: 'prodigi_order_id' },
  );

  await supabase.from('fulfilment_jobs')
    .update({
      status: 'fulfilment_submitted',
      attempts: (job.attempts ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

// ponytail: mapProdigiStage re-exported for consumers who only need the mapping without the full job runner
export { mapProdigiStage } from './status-map';
