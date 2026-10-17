create table users (
  id uuid primary key,
  -- sha256 of the session token; the raw token only ever lives on the client.
  token_hash text not null unique,
  display_name text not null,
  created_at timestamptz not null default now(),
  -- Set only from the verification vendor's result, never by the client.
  verified_adult boolean not null default false,
  verified_sex text check (verified_sex in ('M', 'F', 'X')),
  verification_ref text,
  adult_pass_expires_at timestamptz,
  -- From the payment processor's checkout; used for refund and inactivity notices.
  email text,
  last_active_at timestamptz not null default now(),
  inactivity_reminder_sent_at timestamptz,
  banned boolean not null default false,
  report_count integer not null default 0
);

-- Credits from one purchase. The primary key on the payment reference is what
-- stops a retried processor webhook from crediting the same payment twice.
create table credit_lots (
  payment_ref text primary key,
  user_id uuid not null references users (id),
  purchased_at timestamptz not null default now(),
  pack_credits integer not null check (pack_credits > 0),
  pack_cents integer not null check (pack_cents >= 0),
  remaining integer not null check (remaining >= 0 and remaining <= pack_credits),
  -- A refund was attempted and failed (expired card, charge too old to refund).
  refund_failed boolean not null default false
);
create index credit_lots_user_idx on credit_lots (user_id, purchased_at);

-- Every refund attempt. succeeded is null while the processor call is in
-- flight; rows left null after a crash need reconciling by hand.
create table refunds (
  id bigint generated always as identity primary key,
  user_id uuid not null references users (id),
  payment_ref text not null references credit_lots (payment_ref),
  amount_cents integer not null,
  credits integer not null,
  reason text not null check (reason in ('requested', 'inactivity', 'shutdown')),
  succeeded boolean,
  created_at timestamptz not null default now()
);
create index refunds_user_idx on refunds (user_id);

create table reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references users (id),
  reported_id uuid not null references users (id),
  reason text not null default '',
  created_at timestamptz not null default now()
);
create index reports_reported_idx on reports (reported_id);

create table settings (
  key text primary key,
  value jsonb not null
);
