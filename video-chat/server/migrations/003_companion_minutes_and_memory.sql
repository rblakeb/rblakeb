-- Seconds of AI companion call time the user can still use. New accounts start
-- with a free trial; when it runs out, credits are converted into more minutes.
alter table users add column companion_seconds integer not null default 300 check (companion_seconds >= 0);

-- What each character remembers about a user between calls: short notes the
-- model writes at the end of each call. Users can view and clear them.
create table companion_memories (
  user_id uuid not null references users (id),
  character text not null,
  notes text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, character)
);

-- Keep Supabase's public REST API away from this table too (see 002).
alter table companion_memories enable row level security;
