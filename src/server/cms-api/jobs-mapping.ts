import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintAssetJobRow } from '@/server/asset-jobs/enqueue';
import type { JobResponse } from './types';

// ---------------------------------------------------------------------------
// print_asset_jobs row <-> wire mapping — pure, no I/O. See
// supabase/migrations/20260917170000_print_asset_jobs.sql for the row shape
// and src/server/asset-jobs/enqueue.ts for PrintAssetJobRow's TS shape.
// ---------------------------------------------------------------------------

// Internal DB status -> the contract's narrower Job.status enum
// (queued/processing/completed/failed). failed_retryable and
// failed_action_required both report as the wire 'failed' — the contract has
// no notion of automatic-vs-manual recovery; POST /v1/jobs/{id}/retry accepts
// either (see jobs-retry.ts).
const STATUS_MAP: Record<PrintAssetJobRow['status'], JobResponse['status']> = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  failed_retryable: 'failed',
  failed_action_required: 'failed',
};

/**
 * `progress` has no real tracking in this stub phase (no Sharp step reports
 * partial progress) — 0 while not yet done, 100 once genuinely 'completed'.
 * Phase 3's real processor is the natural place to report real intermediate
 * values; this is a defensible placeholder satisfying the contract's
 * required-integer field without inventing false precision.
 */
function mapProgress(status: PrintAssetJobRow['status']): number {
  return status === 'completed' ? 100 : 0;
}

export function mapJobRowToResponse(row: PrintAssetJobRow): JobResponse {
  return {
    id: row.id,
    // assetId mirrors upload_id in this phase — same convention as
    // uploads-mapping.ts's mapUploadRowToIntent ("assetId mirrors id"):
    // nothing downstream of this stub materializes a distinct asset identity
    // yet (asset_id stays null until Phase 3 actually produces one).
    assetId: row.upload_id,
    revision: row.asset_revision,
    status: STATUS_MAP[row.status],
    progress: mapProgress(row.status),
    error: row.last_error ?? '',
  };
}

// ---------------------------------------------------------------------------
// I/O — always over the handler context's ctx.supabase. Never adminSupabase()
// / getCloudflareContext() (see request-handler.test.ts's Task 5 regression).
// ---------------------------------------------------------------------------

/** GET /v1/jobs has no filtering — same unfiltered/created_at-desc convention as assets-list.ts / content-list.ts (Global Constraint 5). */
export async function listJobRows(supabase: SupabaseClient): Promise<PrintAssetJobRow[]> {
  const { data, error } = await supabase.from('print_asset_jobs').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PrintAssetJobRow[];
}

export async function getJobRowById(supabase: SupabaseClient, id: string): Promise<PrintAssetJobRow | null> {
  const { data, error } = await supabase.from('print_asset_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as PrintAssetJobRow | null) ?? null;
}

const RETRYABLE_FROM_STATUSES = ['failed_retryable', 'failed_action_required'] as const;

/**
 * CAS transition back to 'queued' from a terminal-failed state — the retry
 * endpoint's write. Matches 0 rows both when the id does not exist and when
 * the row's status has already moved on (already retried concurrently, or
 * otherwise advanced) — the caller (jobs-retry.ts) distinguishes those via its
 * own preceding getJobRowById read, exactly as uploads-confirm.ts
 * distinguishes NOT_FOUND from REVISION_CONFLICT.
 */
export async function requeueJobRow(supabase: SupabaseClient, id: string): Promise<PrintAssetJobRow | null> {
  const { data, error } = await supabase
    .from('print_asset_jobs')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', [...RETRYABLE_FROM_STATUSES])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as PrintAssetJobRow | null) ?? null;
}
