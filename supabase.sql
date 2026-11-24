-- Run this once in Supabase → SQL Editor → New query → Run.
-- One table holds every room; the whole game state lives in one JSON column.

create table if not exists public.rooms (
  code        text primary key,
  state       jsonb not null,
  version     int  not null default 1,
  updated_at  timestamptz not null default now()
);

-- Friends-only fun game: anyone with the anon key can read/write rooms.
alter table public.rooms enable row level security;
drop policy if exists "rooms open" on public.rooms;
create policy "rooms open" on public.rooms
  for all to anon, authenticated using (true) with check (true);
grant select, insert, update, delete on public.rooms to anon, authenticated;

-- Live updates (Realtime) for the rooms table
do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;
