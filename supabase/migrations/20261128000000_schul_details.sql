-- Class, participant count and note per school appointment (calendar event id or series id), editable by all active trainers.
create table public.schul_details (
  event_id text primary key,
  klasse text check (char_length(klasse) <= 60),
  anzahl int check (anzahl between 0 and 999),
  notiz text check (char_length(notiz) <= 1000),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.schul_details enable row level security;
create policy "active read schul_details" on public.schul_details for select to authenticated using ((select public.is_active()));
create policy "active insert schul_details" on public.schul_details for insert to authenticated with check ((select public.is_active()));
create policy "active update schul_details" on public.schul_details for update to authenticated using ((select public.is_active())) with check ((select public.is_active()));
create policy "active delete schul_details" on public.schul_details for delete to authenticated using ((select public.is_active()));
grant select, insert, update, delete on public.schul_details to authenticated;
grant all on public.schul_details to service_role;
