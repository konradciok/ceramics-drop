import type { SupabaseClient } from '@supabase/supabase-js';

// Leased-CAS idempotency ledger for the Idempotency-Key header, shaped like
// src/lib/webhook.ts's webhook_events handling but scoped to this API via a
// dedicated table (cms_api_idempotency_keys) rather than overloading the
// Stripe/Prodigi-specific webhook_events ledger. A claim loser is told to
// retry (409) rather than silently dropped, same rationale as the webhook
// ledger's "409-on-claim-loser" design.

const LEASE_MS = 30_000;

export type IdempotencyClaim =
  | { kind: 'run' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'key_reuse' };

async function hashRequest(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body ?? null));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function claimIdempotencyKey(
  supabase: SupabaseClient,
  operation: string,
  idempotencyKey: string,
  requestBody: unknown,
): Promise<IdempotencyClaim> {
  const requestHash = await hashRequest(requestBody);
  const now = new Date().toISOString();

  const insertResult = await supabase
    .from('cms_api_idempotency_keys')
    .insert({ operation, idempotency_key: idempotencyKey, status: 'processing', request_hash: requestHash, processing_started_at: now })
    .select('id')
    .maybeSingle();

  if (!insertResult.error) {
    return { kind: 'run' };
  }

  // 23505 = unique_violation on (operation, idempotency_key) — someone else
  // already holds or completed this key.
  if (insertResult.error.code !== '23505') {
    throw insertResult.error;
  }

  const { data: existing, error: readError } = await supabase
    .from('cms_api_idempotency_keys')
    .select('status, request_hash, response_status, response_body, processing_started_at')
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (readError || !existing) {
    // Racer's insert vanished (should not happen outside a delete) — treat
    // as in-flight so the caller retries rather than double-running work.
    return { kind: 'in_progress' };
  }

  if (existing.request_hash !== requestHash) {
    return { kind: 'key_reuse' };
  }

  if (existing.status === 'done') {
    return { kind: 'replay', status: existing.response_status ?? 200, body: existing.response_body };
  }

  const leaseAge = Date.now() - new Date(existing.processing_started_at).getTime();
  if (existing.status === 'processing' && leaseAge < LEASE_MS) {
    return { kind: 'in_progress' };
  }

  // Stale 'processing' lease or a previously 'failed' attempt — reclaim via
  // CAS on the exact processing_started_at value we just read, so a racer
  // that reclaimed it first is never clobbered.
  const { data: reclaimed, error: reclaimError } = await supabase
    .from('cms_api_idempotency_keys')
    .update({ status: 'processing', processing_started_at: now })
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey)
    .eq('processing_started_at', existing.processing_started_at)
    .select('id')
    .maybeSingle();

  if (reclaimError) throw reclaimError;
  if (!reclaimed) {
    return { kind: 'in_progress' };
  }
  return { kind: 'run' };
}

export async function completeIdempotencyKey(
  supabase: SupabaseClient,
  operation: string,
  idempotencyKey: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  const { error } = await supabase
    .from('cms_api_idempotency_keys')
    .update({ status: 'done', response_status: responseStatus, response_body: responseBody, completed_at: new Date().toISOString() })
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey);
  if (error) throw error;
}

export async function releaseIdempotencyKey(
  supabase: SupabaseClient,
  operation: string,
  idempotencyKey: string,
): Promise<void> {
  const { error } = await supabase
    .from('cms_api_idempotency_keys')
    .update({ status: 'failed' })
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey);
  if (error) throw error;
}
