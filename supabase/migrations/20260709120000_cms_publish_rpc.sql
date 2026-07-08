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
declare
  v_found boolean;
begin
  -- Lock the document row so concurrent publishes for the same doc serialize.
  perform 1 from cms_documents where id = p_document_id for update;
  if not found then
    raise 'document_not_found';
  end if;

  -- The target version must exist for this locale.
  perform 1 from cms_document_versions
    where document_id = p_document_id
      and locale = p_locale
      and version = p_version;
  if not found then
    raise 'version_not_found';
  end if;

  -- Demote any currently-published version for this locale, then promote the
  -- target. Safe under the partial unique index: after the demote there are
  -- zero published rows for this locale, so the promote cannot conflict.
  update cms_document_versions
     set status = 'draft'
   where document_id = p_document_id
     and locale = p_locale
     and status = 'published';

  update cms_document_versions
     set status = 'published'
   where document_id = p_document_id
     and locale = p_locale
     and version = p_version;

  update cms_documents
     set status = 'published',
         updated_at = now(),
         published_at = now()
   where id = p_document_id;

  return query
    select v.id, v.document_id, v.locale, v.version, v.status, v.payload, v.created_by, v.created_at
      from cms_document_versions v
     where v.document_id = p_document_id
       and v.locale = p_locale
       and v.version = p_version;
end;
$$;
