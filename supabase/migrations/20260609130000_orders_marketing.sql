-- Add marketing context captured at checkout, consumed by the Stripe webhook to
-- send consent-gated server-side conversions (Meta CAPI + GA4 MP).
alter table public.orders
  add column if not exists marketing jsonb;

comment on column public.orders.marketing is
  'Marketing context captured at checkout: {consent, fbp, fbc, ga_client_id, ga_session_id, ip, user_agent, event_source_url, captured_at}. Consumed by the Stripe webhook for server-side conversions.';
