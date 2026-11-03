-- ============================================================================
-- Workshops booking (2026-10-21)
-- Tables for workshops.anna-ciok.studio — a separate app and Worker
-- (konradciok/workshops) that shares this Supabase project, the Stripe account
-- and Resend with the shop. This repo owns the schema so the project keeps a
-- single migration history; the app's contract is in its docs/DATABASE.md.
--
-- No copy in the database: workshop titles/descriptions live in the app's
-- messages/*.json under workshops.<slug>; these tables hold structure, prices
-- and availability. Seats are held for 15 minutes by workshop_hold_seats();
-- the app's Stripe webhook settles them via workshop_confirm_payment().
--
-- Access model: RLS on, no policies; only the workshops Worker (service role)
-- reads or writes. Every object is prefixed workshop(s)_ so it can't be
-- mistaken for shop objects (orders, reserve_pieces, …).
--
-- Backward-compatibility: purely additive — new tables, view and RPCs only.
-- The shop never reads or writes any of it.
-- ============================================================================

create table workshops (
  id                text primary key,                -- 'w_akwarela'
  slug              text unique not null,            -- i18n key: workshops.<slug>
  price_cents       integer not null check (price_cents > 0),
  currency          text not null default 'eur',
  duration_min      integer not null check (duration_min > 0),
  capacity          integer not null check (capacity > 0),
  pickup_after_days integer check (pickup_after_days > 0), -- ceramics: kiln firing → pickup date
  cover             jsonb not null,                  -- {src,w,h}
  gallery           jsonb not null default '[]',     -- [{src,w,h}]
  sort              integer not null default 0,
  active            boolean not null default true
);

create table workshop_sessions (
  id                text primary key,
  workshop_id       text not null references workshops (id),
  starts_at         timestamp not null,              -- Atlantic/Canary wall-clock
  lang              text not null,                   -- teaching language (ISO 639-1)
  capacity_override integer check (capacity_override >= 0),
  cancelled         boolean not null default false
);
create index workshop_sessions_workshop_starts_idx on workshop_sessions (workshop_id, starts_at);

create table workshop_bookings (
  id                         uuid primary key default gen_random_uuid(),
  ref                        text unique not null,   -- ACW-XXXX-XXXX
  session_id                 text not null references workshop_sessions (id),
  seats                      integer not null check (seats between 1 and 6),
  status                     text not null check (status in ('held', 'paid', 'expired', 'failed', 'refunded')),
  hold_expires_at            timestamptz not null,
  name                       text,
  email                      text,
  phone                      text,
  notes                      text,
  newsletter                 boolean not null default false,
  locale                     text not null,
  stripe_session_id          text,
  stripe_payment_intent      text,
  -- Each email goes out at most once (the app also sends a Resend Idempotency-Key).
  confirmation_email_sent_at timestamptz,
  studio_email_sent_at       timestamptz,
  refund_email_sent_at       timestamptz,
  resend_email_id            text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index workshop_bookings_session_active_idx on workshop_bookings (session_id) where status in ('held', 'paid');

alter table workshops enable row level security;
alter table workshop_sessions enable row level security;
alter table workshop_bookings enable row level security;

-- Seats count as taken while paid, or held and the hold has not lapsed.
create view workshop_sessions_public
with (security_invoker = true) as
select
  s.id,
  s.workshop_id,
  s.starts_at,
  s.lang,
  coalesce(s.capacity_override, w.capacity) as capacity,
  greatest(
    0,
    coalesce(s.capacity_override, w.capacity) - coalesce((
      select sum(b.seats)
      from workshop_bookings b
      where b.session_id = s.id
        and (b.status = 'paid' or (b.status = 'held' and b.hold_expires_at > now()))
    ), 0)
  )::integer as seats_left
from workshop_sessions s
join workshops w on w.id = s.workshop_id
where not s.cancelled and w.active;

revoke all on workshop_sessions_public from anon, authenticated;

-- Reserve seats for p_minutes. Locks the session row so concurrent holds and
-- payment confirmations for the same session are serialised.
create function workshop_hold_seats(
  p_session_id text,
  p_seats      integer,
  p_ref        text,
  p_locale     text,
  p_minutes    integer default 15
) returns workshop_bookings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_capacity integer;
  v_taken    integer;
  v_booking  workshop_bookings;
begin
  if p_seats < 1 or p_seats > 6 then
    raise exception 'invalid_seats';
  end if;

  select coalesce(s.capacity_override, w.capacity) into v_capacity
  from workshop_sessions s
  join workshops w on w.id = s.workshop_id
  where s.id = p_session_id
    and not s.cancelled
    and w.active
    and s.starts_at >= (now() at time zone 'Atlantic/Canary')
  for update of s;

  if not found then
    raise exception 'not_found';
  end if;

  select coalesce(sum(seats), 0) into v_taken
  from workshop_bookings
  where session_id = p_session_id
    and (status = 'paid' or (status = 'held' and hold_expires_at > now()));

  if v_capacity - v_taken < p_seats then
    raise exception 'sold_out';
  end if;

  insert into workshop_bookings (ref, session_id, seats, status, hold_expires_at, locale)
  values (p_ref, p_session_id, p_seats, 'held', now() + make_interval(mins => p_minutes), p_locale)
  returning * into v_booking;

  return v_booking;
end;
$$;

-- Called by the app's Stripe webhook once money has arrived. Returns
-- 'paid' | 'already_paid' | 'already_refunded' | 'refund_needed' | 'not_found'.
-- A payment that lands after its hold lapsed is still honoured if the seats
-- are free; otherwise the caller refunds it ("this date has just filled up").
create function workshop_confirm_payment(p_ref text, p_payment_intent text)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_session_id text;
  v_capacity   integer;
  v_taken      integer;
  v_booking    workshop_bookings;
begin
  select session_id into v_session_id from workshop_bookings where ref = p_ref;
  if not found then
    return 'not_found';
  end if;

  -- Same lock order as workshop_hold_seats: session row first, then the booking.
  select coalesce(s.capacity_override, w.capacity) into v_capacity
  from workshop_sessions s
  join workshops w on w.id = s.workshop_id
  where s.id = v_session_id
  for update of s;

  select * into v_booking from workshop_bookings where ref = p_ref for update;

  if v_booking.status = 'paid' then
    return 'already_paid';
  elsif v_booking.status = 'refunded' then
    return 'already_refunded';
  end if;

  update workshop_bookings
  set stripe_payment_intent = p_payment_intent, updated_at = now()
  where id = v_booking.id;

  if not (v_booking.status = 'held' and v_booking.hold_expires_at > now()) then
    select coalesce(sum(seats), 0) into v_taken
    from workshop_bookings
    where session_id = v_session_id
      and id <> v_booking.id
      and (status = 'paid' or (status = 'held' and hold_expires_at > now()));

    if v_capacity - v_taken < v_booking.seats then
      return 'refund_needed';
    end if;
  end if;

  update workshop_bookings set status = 'paid', updated_at = now() where id = v_booking.id;
  return 'paid';
end;
$$;

revoke all on function workshop_hold_seats(text, integer, text, text, integer) from public;
revoke execute on function workshop_hold_seats(text, integer, text, text, integer) from anon, authenticated;
grant execute on function workshop_hold_seats(text, integer, text, text, integer) to service_role;

revoke all on function workshop_confirm_payment(text, text) from public;
revoke execute on function workshop_confirm_payment(text, text) from anon, authenticated;
grant execute on function workshop_confirm_payment(text, text) to service_role;
