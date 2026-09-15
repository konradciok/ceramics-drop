-- CMS API — collections drafts, publish/restore RPCs.
-- -----------------------------------------------------------------------------
-- Additive resource type mirroring supabase/migrations/20260912120000_cms_api_products.sql's
-- product_drafts / products.published_revision / create_product_with_draft /
-- save_product_draft / publish_product_revision pattern, but simpler: a
-- collection has no ceramic/print structural columns of its own — its entire
-- editable content is the {name, fields} payload carried by collection_drafts,
-- keyed by (collection_id, revision) exactly like product_drafts. There is no
-- status/state-machine column (no draft/active/hidden/archived here — see
-- docs/plans' Global Constraint 6) and no DELETE.
--
-- Also relaxes catalog_audit_log.product_id to nullable and adds a nullable
-- collection_id so one shared audit table can scope rows to either resource
-- type (exactly one of the two must be set — see the num_nonnulls check
-- below). This is the same table create_product_with_draft/save_product_draft/
-- publish_product_revision already write to; a regression check in the
-- companion pgTAP file re-runs those three RPCs after this alteration to
-- prove the relaxed constraint didn't break the existing product-audit path.
--
-- Same RLS posture as every sibling table: enabled, no policies (service-role
-- only, via the CmsApi Worker's service-role key).

-- 1. collections ─────────────────────────────────────────────────────────────
-- published_revision is added below (step 3) once collection_drafts exists.
-- collections and collection_drafts have a circular FK dependency
-- (collections.published_revision -> collection_drafts(collection_id,
-- revision); collection_drafts.collection_id -> collections(id)) that products
-- resolved across two separate migrations (20260709140000_catalog_shadow.sql
-- created products first; 20260912120000_cms_api_products.sql added
-- product_drafts + the FK later). Both new tables live in this one file, so
-- the same resolution happens in steps within it: create collections WITHOUT
-- published_revision (this step), create collection_drafts referencing it
-- (step 2), then add published_revision + its composite FK back onto
-- collections (step 3).
create table collections (
  id            text primary key,                       -- stable token, e.g. 'col_1a2b3c4d5e'
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table collections enable row level security;

-- 2. collection_drafts ────────────────────────────────────────────────────────
-- One immutable row per saved draft, exactly like product_drafts: (collection_id,
-- revision) is unique, revision starts at 1 and only ever increments. payload
-- is the {name, fields} object directly (no wrapper key — Global Constraint 2).
create table collection_drafts (
  id            uuid primary key default gen_random_uuid(),
  collection_id text not null references collections(id) on delete cascade,
  revision      integer not null,
  payload       jsonb not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  unique (collection_id, revision)
);

alter table collection_drafts enable row level security;

create index collection_drafts_collection_idx on collection_drafts (collection_id, revision desc);

-- 3. collections.published_revision ──────────────────────────────────────────
alter table collections add column published_revision integer;

alter table collections
  add constraint collections_published_revision_fk
  foreign key (id, published_revision) references collection_drafts (collection_id, revision);

-- 4. catalog_audit_log: relax product_id, add collection_id ──────────────────
-- collection_id is deliberately NOT a foreign key, same as product_id (see
-- 20260710120000_catalog_audit_log.sql's header comment: audit rows must
-- survive id removal). Relaxing product_id's NOT NULL (rather than adding a
-- second always-required column) means every existing product-audit row
-- (product_id set, collection_id null) already satisfies the new check below
-- without a backfill.
alter table catalog_audit_log alter column product_id drop not null;
alter table catalog_audit_log add column collection_id text;

-- NOT VALID first so the ADD CONSTRAINT itself doesn't hold an exclusive lock
-- for a full-table scan; VALIDATE immediately after — same safe pattern as
-- products_ceramic_price_present / products_ceramic_category_valid
-- (20260813170000_harden_rpc_and_catalog.sql, 20260913230000_ceramic_category_check.sql).
-- Every existing row has product_id set and collection_id null (just added),
-- so num_nonnulls = 1 already holds for all of them — VALIDATE cannot fail.
alter table catalog_audit_log
  add constraint catalog_audit_log_product_or_collection_check
  check (num_nonnulls(product_id, collection_id) = 1) not valid;
alter table catalog_audit_log validate constraint catalog_audit_log_product_or_collection_check;

-- Partial (collection_id is only ever set on collection rows) index mirroring
-- catalog_audit_log_product_idx's shape (id, created_at desc).
create index catalog_audit_log_collection_idx
  on catalog_audit_log (collection_id, created_at desc)
  where collection_id is not null;

-- 5. create_collection_with_draft ─────────────────────────────────────────────
-- Atomically creates the collections row and its first collection_drafts
-- revision. p_id is generated by the caller (col_<10 hex>); a collision
-- (extremely unlikely) surfaces as a 23505 unique_violation on
-- collections_pkey for the caller to catch and retry with a new id — same
-- convention as create_product_with_draft.
create or replace function create_collection_with_draft(
  p_id          text,
  p_payload     jsonb,
  p_actor_email text
) returns collection_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row collection_drafts%rowtype;
begin
  insert into collections (id) values (p_id);

  insert into collection_drafts (collection_id, revision, payload, created_by)
  values (p_id, 1, p_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (collection_id, actor_email, action, before, after, revision)
  values (p_id, p_actor_email, 'draft_saved', null, p_payload, 1);

  return v_row;
end;
$$;

revoke all on function create_collection_with_draft(text, jsonb, text) from public, anon, authenticated;
grant execute on function create_collection_with_draft(text, jsonb, text) to service_role;

-- 6. save_collection_draft ─────────────────────────────────────────────────────
create or replace function save_collection_draft(
  p_collection_id     text,
  p_expected_revision integer,
  p_payload           jsonb,
  p_actor_email       text
) returns collection_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision      integer;
  v_row               collection_drafts%rowtype;
  v_previous          jsonb;
begin
  perform 1 from collections c where c.id = p_collection_id for update;
  if not found then
    raise 'collection_not_found';
  end if;

  select coalesce(max(cd.revision), 0)
    into v_current_revision
    from collection_drafts cd
   where cd.collection_id = p_collection_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select cd.payload
    into v_previous
    from collection_drafts cd
   where cd.collection_id = p_collection_id
   order by cd.revision desc
   limit 1;

  v_new_revision := v_current_revision + 1;

  insert into collection_drafts (collection_id, revision, payload, created_by)
  values (p_collection_id, v_new_revision, p_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (collection_id, actor_email, action, before, after, revision)
  values (p_collection_id, p_actor_email, 'draft_saved', v_previous, p_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function save_collection_draft(text, integer, jsonb, text) from public, anon, authenticated;
grant execute on function save_collection_draft(text, integer, jsonb, text) to service_role;

-- 7. publish_collection_revision ───────────────────────────────────────────────
-- p_payload's fields (Field[], see the contract's Field schema) drive two
-- publish-time checks with no product precedent:
--   - missing_polish: every field with locale='pl' must have a non-blank
--     (trimmed) value, AND at least one locale='pl' field must exist.
--   - product_ref_invalid: every id in a productIds-type field's CSV value
--     must exist in products. An empty CSV is valid. The detail-string format
--     (invalidIds=%s) is pinned by Global Constraint 11 — Task 7 parses it
--     verbatim, do not change the format here.
-- Neither check has anything to materialize onto a structural table (unlike
-- publish_product_revision's product_variants/product_media/piece_state
-- writes) — publishing a collection only stamps published_revision.
create or replace function publish_collection_revision(
  p_collection_id     text,
  p_expected_revision integer,
  p_actor_email       text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_collection        collections%rowtype;
  v_payload            jsonb;
  v_before             jsonb;
  v_after              jsonb;
  v_field              jsonb;
  v_has_pl             boolean := false;
  v_pl_value           text;
  v_token              text;
  v_invalid_ids        text[] := array[]::text[];
begin
  select * into v_collection from collections c where c.id = p_collection_id for update;
  if not found then
    raise 'collection_not_found';
  end if;

  select coalesce(max(cd.revision), 0)
    into v_current_revision
    from collection_drafts cd
   where cd.collection_id = p_collection_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  -- revision 0 means "no draft has ever been saved" (collection_drafts.revision
  -- starts at 1). collections.published_revision has a composite FK to
  -- collection_drafts(collection_id, revision), so publishing at revision 0
  -- would otherwise hit an unmapped FK-violation 500 instead of a clear 4xx.
  if p_expected_revision = 0 then
    raise 'draft_required';
  end if;

  select cd.payload
    into v_payload
    from collection_drafts cd
   where cd.collection_id = p_collection_id
     and cd.revision = p_expected_revision;

  -- missing_polish: raised on the first blank 'pl' field encountered, or
  -- after the loop if no 'pl' field was present at all.
  for v_field in select * from jsonb_array_elements(coalesce(v_payload->'fields', '[]'::jsonb))
  loop
    if v_field->>'locale' = 'pl' then
      v_has_pl := true;
      v_pl_value := v_field->>'value';
      if v_pl_value is null or btrim(v_pl_value) = '' then
        raise 'missing_polish';
      end if;
    end if;
  end loop;

  if not v_has_pl then
    raise 'missing_polish';
  end if;

  -- product_ref_invalid: check every productIds-type field's CSV value.
  -- products.id is text primary key with no format CHECK, so a plain
  -- existence check per non-blank, trimmed token is sufficient.
  for v_field in select * from jsonb_array_elements(coalesce(v_payload->'fields', '[]'::jsonb))
  loop
    if v_field->>'type' = 'productIds' then
      for v_token in
        select btrim(t) from unnest(string_to_array(coalesce(v_field->>'value', ''), ',')) as t
      loop
        if v_token <> '' and not exists (select 1 from products p where p.id = v_token) then
          v_invalid_ids := array_append(v_invalid_ids, v_token);
        end if;
      end loop;
    end if;
  end loop;

  if array_length(v_invalid_ids, 1) is not null then
    raise exception 'product_ref_invalid' using detail = format('invalidIds=%s', array_to_string(v_invalid_ids, ','));
  end if;

  v_before := to_jsonb(v_collection);

  update collections c set
    published_revision = p_expected_revision,
    published_at       = coalesce(c.published_at, now()),
    updated_at          = now()
  where c.id = p_collection_id;

  select * into v_collection from collections c where c.id = p_collection_id;
  v_after := to_jsonb(v_collection);

  insert into catalog_audit_log (collection_id, actor_email, action, before, after, revision)
  values (p_collection_id, p_actor_email, 'published', v_before, v_after, p_expected_revision);

  return jsonb_build_object('ok', true, 'collection', v_after);
end;
$$;

revoke all on function publish_collection_revision(text, integer, text) from public, anon, authenticated;
grant execute on function publish_collection_revision(text, integer, text) to service_role;

-- 8. restore_collection_draft ──────────────────────────────────────────────────
-- Zero backend precedent (no restore_* RPC exists anywhere else in this repo).
-- Re-saves an old revision's payload as a brand-new revision (current max + 1)
-- — nothing is ever deleted or rewritten (docs/cms-api-data-model.md). Must
-- never touch collections.published_revision: restoring an old draft does not
-- publish it.
create or replace function restore_collection_draft(
  p_collection_id     text,
  p_expected_revision integer,
  p_source_revision   integer,
  p_actor_email       text
) returns collection_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision      integer;
  v_source_payload    jsonb;
  v_previous           jsonb;
  v_row                collection_drafts%rowtype;
begin
  perform 1 from collections c where c.id = p_collection_id for update;
  if not found then
    raise 'collection_not_found';
  end if;

  select coalesce(max(cd.revision), 0)
    into v_current_revision
    from collection_drafts cd
   where cd.collection_id = p_collection_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select cd.payload
    into v_source_payload
    from collection_drafts cd
   where cd.collection_id = p_collection_id
     and cd.revision = p_source_revision;

  if not found then
    raise 'source_revision_not_found';
  end if;

  select cd.payload
    into v_previous
    from collection_drafts cd
   where cd.collection_id = p_collection_id
   order by cd.revision desc
   limit 1;

  v_new_revision := v_current_revision + 1;

  insert into collection_drafts (collection_id, revision, payload, created_by)
  values (p_collection_id, v_new_revision, v_source_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (collection_id, actor_email, action, before, after, revision)
  values (p_collection_id, p_actor_email, 'restored', v_previous, v_source_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function restore_collection_draft(text, integer, integer, text) from public, anon, authenticated;
grant execute on function restore_collection_draft(text, integer, integer, text) to service_role;

-- ============================================================
-- Rollback (manual):
--   drop function if exists restore_collection_draft(text, integer, integer, text);
--   drop function if exists publish_collection_revision(text, integer, text);
--   drop function if exists save_collection_draft(text, integer, jsonb, text);
--   drop function if exists create_collection_with_draft(text, jsonb, text);
--   drop index if exists catalog_audit_log_collection_idx;
--   alter table catalog_audit_log drop constraint if exists catalog_audit_log_product_or_collection_check;
--   alter table catalog_audit_log drop column if exists collection_id;
--   alter table catalog_audit_log alter column product_id set not null;
--   alter table collections drop constraint if exists collections_published_revision_fk;
--   alter table collections drop column if exists published_revision;
--   drop table if exists collection_drafts;
--   drop table if exists collections;
-- ============================================================
