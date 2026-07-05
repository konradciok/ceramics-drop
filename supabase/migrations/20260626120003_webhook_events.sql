create table webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null,
  provider_event_id     text,
  event_type            text,
  status                text not null default 'processing',
  raw_json              jsonb,
  processing_started_at timestamptz,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);
-- Dedup gate: one row per (provider, event id).
create unique index webhook_events_dedup
  on webhook_events(provider, provider_event_id)
  where provider_event_id is not null;
alter table webhook_events enable row level security;
