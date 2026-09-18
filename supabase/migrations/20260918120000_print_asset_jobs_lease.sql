-- Lease + fencing token for print_asset_jobs' claim query (CodeRabbit PR #318
-- round 2, Task G / Finding 1): the claim query previously reclaimed ANY row
-- with status IN ('queued', 'failed_retryable', 'processing') unconditionally
-- (process-job.ts:106-112, pre-fix), so a duplicate/redelivered message for the
-- same jobId could re-claim and re-run the whole render pipeline concurrently
-- with a still-running original — and `failJob`/the finalize update wrote
-- `.eq('id', jobId)` alone, no ownership predicate, so whichever delivery
-- finished LAST silently won, even over a result an earlier delivery had
-- already written.
--
-- lease_expires_at: set on every successful claim to now() + a bounded job
-- budget (process-job.ts's JOB_LEASE_MS — deliberately derived from the same
-- JOB_DEADLINE_MS budget introduced alongside this migration for Finding 2's
-- job-wide render deadline, plus a grace margin: "how long can this job
-- legitimately run" is one concept, not two independently-chosen numbers).
-- `processing` stays in the claim query's claimable set (CodeRabbit's own
-- persistent-learnings note: "a claim-with-lease queue must reclaim only
-- expired processing rows" — this is the crash-recovery path for a worker that
-- died mid-job) but ONLY when its lease has expired — see process-job.ts's
-- `.or(...)` claim filter.
--
-- lease_token: a fresh crypto.randomUUID() minted on every successful claim.
-- Every subsequent write to the row from that worker (failJob, the finalize
-- update) threads it through as an ADDITIONAL `.eq('lease_token', ...)`
-- predicate — this is the fencing check: a "zombie" worker whose lease has
-- since expired and been reclaimed by someone else has a lease_token that no
-- longer matches the row's current one, so its write matches 0 rows and is
-- logged, not applied (same tolerant 0-rows-matched shape the finalize CAS
-- already used before this migration).
--
-- Backfill: a row already `processing` at deploy time predates lease tracking
-- entirely, so lease_expires_at defaults to NULL — and NULL never satisfies
-- `lease_expires_at < now()`, which would otherwise strand it unclaimable
-- forever (worse than the bug this migration fixes). Backfilling it to now()
-- treats every such row as already-expired, i.e. immediately reclaimable — the
-- same fail-open, "recoverable over silently stuck" posture the rest of this
-- fix takes, and safe because the render pipeline downstream is already
-- idempotent (content-addressed R2 keys, `ignoreDuplicates` staging upsert).
--
-- Additive + backward-compatible: nullable, no default for new 'queued' rows
-- (a row only gets a lease once actually claimed). Auto-applies on merge.
--
-- ============================================================
-- Rollback (manual):
--   alter table print_asset_jobs drop column lease_expires_at;
--   alter table print_asset_jobs drop column lease_token;
-- ============================================================
alter table print_asset_jobs add column if not exists lease_expires_at timestamptz;
alter table print_asset_jobs add column if not exists lease_token uuid;

update print_asset_jobs
  set lease_expires_at = now()
  where status = 'processing' and lease_expires_at is null;
