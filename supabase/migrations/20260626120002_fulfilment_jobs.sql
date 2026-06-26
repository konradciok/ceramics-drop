create table fulfilment_jobs (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  provider        text not null default 'prodigi',
  status          text not null default 'queued',
  attempts        integer not null default 0,
  idempotency_key text not null unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Prevent duplicate active jobs per order.
create unique index fulfilment_jobs_order_unique
  on fulfilment_jobs(order_id)
  where status not in ('cancelled', 'failed_action_required');
alter table fulfilment_jobs enable row level security;

create table prodigi_orders (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id),
  prodigi_order_id      text unique,
  prodigi_status_stage  text,
  prodigi_raw_json      jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter table prodigi_orders enable row level security;
