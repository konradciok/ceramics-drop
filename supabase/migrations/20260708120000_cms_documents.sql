create table cms_documents (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  slug         text not null,
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz,
  unique (kind, slug)
);

create table cms_document_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references cms_documents(id) on delete cascade,
  locale      text not null check (locale in ('pl', 'en', 'es', 'de')),
  version     integer not null,
  status      text not null check (status in ('draft', 'published')),
  payload     jsonb not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (document_id, locale, version)
);

create unique index cms_document_versions_one_published
  on cms_document_versions(document_id, locale)
  where status = 'published';

create index cms_documents_kind_slug_idx
  on cms_documents(kind, slug);

create index cms_document_versions_document_locale_idx
  on cms_document_versions(document_id, locale, created_at desc);

create table cms_audit_log (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid references cms_documents(id),
  actor_email text,
  action      text not null,
  locale      text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create index cms_audit_log_document_idx
  on cms_audit_log(document_id, created_at desc);

alter table cms_documents enable row level security;
alter table cms_document_versions enable row level security;
alter table cms_audit_log enable row level security;
