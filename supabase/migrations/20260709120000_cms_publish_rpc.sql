-- Atomic CMS version publish. Replaces the three separate updates that
-- publishVersion() used to issue from app code (demote old published → promote
-- target → mark the document published). A failure between those calls could
-- leave a locale with zero published rows (the partial unique index
-- cms_document_versions_one_published allows zero), and concurrent publishes
-- for the same document could race. This RPC performs all three mutations in a
-- single transaction under a document-level FOR UPDATE lock, so a partial
-- publish is impossible and concurrent publishes serialize.
create or replace function publish_cms_version(
  p_document_id  uuid,
  p_locale       text,
  p_version      integer
) returns table (
  id          uuid,
  document_id uuid,
  locale      text,
  version     integer,
  status      text,
  payload     jsonb,
  created_by  text,
  created_at  timestamptz
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Qualify EVERY column reference with a table alias. The RETURNS TABLE
  -- columns (id, document_id, locale, version, status, ...) are also
  -- OUT-parameter names in scope here, so a bare `id` / `status` /
  -- `document_id` is ambiguous (SQLSTATE 42702) between the table column and
  -- the output parameter.
  perform 1 from cms_documents d where d.id = p_document_id for update;
  if not found then
    raise 'document_not_found';
  end if;

  -- The target version must exist for this locale.
  perform 1 from cms_document_versions v
    where v.document_id = p_document_id
      and v.locale = p_locale
      and v.version = p_version;
  if not found then
    raise 'version_not_found';
  end if;

  -- Demote any currently-published version for this locale, then promote the
  -- target. Safe under the partial unique index: after the demote there are
  -- zero published rows for this locale, so the promote cannot conflict.
  update cms_document_versions v
     set status = 'draft'
   where v.document_id = p_document_id
     and v.locale = p_locale
     and v.status = 'published';

  update cms_document_versions v
     set status = 'published'
   where v.document_id = p_document_id
     and v.locale = p_locale
     and v.version = p_version;

  update cms_documents d
     set status = 'published',
         updated_at = now(),
         published_at = now()
   where d.id = p_document_id;

  return query
    select v.id, v.document_id, v.locale, v.version, v.status, v.payload, v.created_by, v.created_at
      from cms_document_versions v
     where v.document_id = p_document_id
       and v.locale = p_locale
       and v.version = p_version;
end;
$$;
