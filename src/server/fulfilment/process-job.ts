import { getSupabaseAdmin } from '@/lib/supabase';
import { signPrintAssetUrl } from '@/lib/print-assets';
import { getAssetForFulfilment } from '@/server/print-assets/repository';
import { prodigiClient, ProdigiError } from '../prodigi/client';
import { buildProdigiPayload, printItemAssetKey, type OrderRow, type PrintItemRow } from '../prodigi/mapper';
import type { FulfilmentJobMessage } from '../prodigi/types';

type AssetResolveResult =
  | { ok: true; url: string; shaPrefix: string; revision: string }
  | { ok: false; kind: 'action_required'; reason: string }
  | { ok: false; kind: 'retryable'; reason: string };

function shaPrefix(sha256: string): string {
  return sha256.slice(0, 8);
}

async function resolveSignedAssetUrl(
  item: PrintItemRow,
  env: CloudflareEnv,
): Promise<AssetResolveResult> {
  const { variant } = item;
  if (!variant.assetId) {
    return { ok: false, kind: 'action_required', reason: `order item ${item.product_id} has no snapshotted assetId` };
  }
  if (!env.PRINT_ASSETS || !env.PRINT_ASSET_TOKEN_SECRET) {
    return {
      ok: false,
      kind: 'action_required',
      reason: 'PRINT_ASSETS binding or PRINT_ASSET_TOKEN_SECRET missing — cannot sign fulfilment asset',
    };
  }

  let record;
  try {
    record = await getAssetForFulfilment(variant.assetId);
  } catch (e) {
    return { ok: false, kind: 'retryable', reason: String(e) };
  }

  if (!record) {
    return {
      ok: false,
      kind: 'action_required',
      reason: `fulfilment asset ${variant.assetId} not found or revoked (sha ${shaPrefix(variant.assetSha256)})`,
    };
  }

  // Defense in depth: the checkout snapshot must match the live row we sign.
  if (record.sha256 !== variant.assetSha256) {
    return {
      ok: false,
      kind: 'action_required',
      reason: `asset ${variant.assetId} sha mismatch at fulfilment (snapshot ${shaPrefix(variant.assetSha256)}, db ${shaPrefix(record.sha256)})`,
    };
  }

  try {
    const obj = await env.PRINT_ASSETS.head(record.r2Key);
    if (!obj) {
      return {
        ok: false,
        kind: 'action_required',
        reason: `R2 object missing for asset ${variant.assetId} revision ${record.revision} (sha ${shaPrefix(record.sha256)})`,
      };
    }
  } catch (e) {
    return { ok: false, kind: 'retryable', reason: `R2 head failed for asset ${variant.assetId}: ${String(e)}` };
  }

  const url = await signPrintAssetUrl(variant.assetId, env.PRINT_ASSET_TOKEN_SECRET);
  return {
    ok: true,
    url,
    shaPrefix: shaPrefix(record.sha256),
    revision: record.revision,
  };
}

export async function processJob(
  msg: FulfilmentJobMessage,
  env: CloudflareEnv,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: ExecutionContext,
): Promise<void> {
  const { orderId, jobId } = msg;
  const supabase = getSupabaseAdmin();
  const now = () => new Date().toISOString();

  // Throws → queue retry; used for every write whose loss would strand the job.
  const failJob = async (status: string, lastError: string, attempts?: number) => {
    const { error } = await supabase.from('fulfilment_jobs')
      .update({
        status,
        last_error: lastError,
        ...(attempts !== undefined ? { attempts } : {}),
        updated_at: now(),
      })
      .eq('id', jobId);
    if (error) throw error;
  };

  // 1. Claim the job with a single conditional update (no read-then-write race).
  // ponytail: 'fulfilment_submitting' stays claimable so a crash between POST and
  // persist can be retried — Prodigi's idempotencyKey + 409 recovery below make a
  // duplicate POST harmless.
  const { data: job, error: claimErr } = await supabase
    .from('fulfilment_jobs')
    .update({ status: 'fulfilment_submitting', updated_at: now() })
    .eq('id', jobId)
    .in('status', ['queued', 'failed_retryable', 'fulfilment_submitting'])
    .select('attempts')
    .maybeSingle();

  if (claimErr) throw claimErr; // queue retries
  if (!job) return; // already terminal / submitted — duplicate delivery

  // 2. Load order (columns as persisted by /api/checkout — see mapper.OrderRow).
  const { data: order } = await supabase
    .from('orders')
    .select('id, status, currency, email, receiver_first_name, receiver_last_name, receiver_phone, shipping_address, delivery_method')
    .eq('id', orderId)
    .single<OrderRow & { status: string }>();

  if (!order || order.status !== 'paid') {
    await failJob('failed_action_required', 'order not paid');
    return;
  }
  if (!order.shipping_address) {
    await failJob('failed_action_required', 'order has no shipping address — prints require courier delivery');
    return;
  }

  // 3. Load print line items.
  const { data: items } = await supabase
    .from('order_items')
    .select('product_id, unit_price, variant')
    .eq('order_id', orderId)
    .not('variant', 'is', null)
    .returns<PrintItemRow[]>();

  if (!items || items.length === 0) {
    await failJob('failed_action_required', 'no print items found');
    return;
  }

  // 4. Resolve signed asset URLs — fail-closed; never fall back to storefront WebP.
  const assetUrls: Record<string, string> = {};
  const assetMeta: string[] = [];
  for (const item of items) {
    const resolved = await resolveSignedAssetUrl(item, env);
    if (!resolved.ok) {
      const status = resolved.kind === 'retryable' ? 'failed_retryable' : 'failed_action_required';
      await failJob(status, resolved.reason, (job.attempts ?? 0) + 1);
      if (resolved.kind === 'retryable') throw new Error(resolved.reason);
      return;
    }
    assetUrls[printItemAssetKey(item)] = resolved.url;
    assetMeta.push(`${item.variant.assetId} rev ${resolved.revision} sha ${resolved.shaPrefix}`);
  }
  console.info(
    `processJob: order ${orderId} signing ${items.length} asset(s): ${assetMeta.join('; ')}`,
  );

  // 5. Build and POST Prodigi order.
  const client = prodigiClient(env);
  let payload;
  try {
    payload = buildProdigiPayload(order, items, assetUrls, env);
  } catch (e) {
    await failJob('failed_action_required', String(e), (job.attempts ?? 0) + 1);
    return;
  }

  let prodigiOrderId: string;
  try {
    const res = await client.postOrder(payload);
    prodigiOrderId = res.order.id;
  } catch (e) {
    // 409 = idempotencyKey duplicate: the order already exists on Prodigi.
    // Recover its id from the response body instead of failing the job.
    const dupId = e instanceof ProdigiError && e.status === 409
      ? (e.body as { order?: { id?: string } } | null)?.order?.id
      : undefined;
    if (dupId) {
      prodigiOrderId = dupId;
    } else if (e instanceof ProdigiError && e.status === 409) {
      // Order exists but the body carried no id — callbacks will reconcile via
      // merchantReference; do not create a second order.
      await failJob('fulfilment_submitted', '409 duplicate — order exists on Prodigi, id unknown', (job.attempts ?? 0) + 1);
      return;
    } else {
      const retryable = e instanceof ProdigiError ? e.retryable : true;
      await failJob(
        retryable ? 'failed_retryable' : 'failed_action_required',
        String(e),
        (job.attempts ?? 0) + 1,
      );
      if (retryable) throw e; // Causes queue to retry.
      return;
    }
  }

  // 6. Persist Prodigi order + mark submitted. Errors throw → queue retry
  // (re-POST hits 409 above and lands back here with the recovered id).
  const { error: poErr } = await supabase.from('prodigi_orders').upsert(
    { order_id: orderId, prodigi_order_id: prodigiOrderId, prodigi_status_stage: 'InProgress' },
    { onConflict: 'prodigi_order_id' },
  );
  if (poErr) throw poErr;

  const { error: doneErr } = await supabase.from('fulfilment_jobs')
    .update({
      status: 'fulfilment_submitted',
      attempts: (job.attempts ?? 0) + 1,
      updated_at: now(),
    })
    .eq('id', jobId);
  if (doneErr) throw doneErr;
}

// ponytail: mapProdigiStage re-exported for consumers who only need the mapping without the full job runner
export { mapProdigiStage } from './status-map';
