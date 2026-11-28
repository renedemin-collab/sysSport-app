-- Attendance recorded in the app by trainers without Virtuagym access; the admin transfers it to Virtuagym.
create table public.attendance (
  event_id text primary key,
  name text not null,
  s bigint not null,
  e bigint not null,
  trainer text,
  people jsonb not null default '[]',
  extra jsonb not null default '[]',
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_by_name text,
  confirmed_at timestamptz not null default now(),
  done boolean not null default false,
  done_at timestamptz
);
alter table public.attendance enable row level security;
create policy "active read attendance" on public.attendance for select to authenticated using ((select public.is_active()));
-- Trainers may record or correct attendance until the admin has transferred it to Virtuagym.
create policy "active insert attendance" on public.attendance for insert to authenticated
  with check ((select public.is_active()) and done = false);
create policy "active update open attendance" on public.attendance for update to authenticated
  using ((select public.is_active()) and (done = false or (select public.is_admin())))
  with check ((select public.is_active()) and (done = false or (select public.is_admin())));
create policy "admin delete attendance" on public.attendance for delete to authenticated using ((select public.is_admin()));
grant select, insert, update, delete on public.attendance to authenticated;
grant all on public.attendance to service_role;

insert into public.app_settings(key, value) values ('ha_dashboard_url', '') on conflict do nothing;
