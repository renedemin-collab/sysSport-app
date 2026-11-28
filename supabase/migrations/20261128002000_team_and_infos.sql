-- Team contacts and info items (e.g. tablet PINs). Values are entered in the app's admin area,
-- never committed here: this repository is public.
create table public.team_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) <= 60),
  phone text check (char_length(phone) <= 40),
  role text check (char_length(role) <= 60),
  sort int not null default 50
);
create table public.info_items (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) <= 80),
  value text not null check (char_length(value) <= 200),
  sort int not null default 50
);
alter table public.team_contacts enable row level security;
alter table public.info_items enable row level security;
create policy "active read team" on public.team_contacts for select to authenticated using ((select public.is_active()));
create policy "admin write team" on public.team_contacts for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "active read infos" on public.info_items for select to authenticated using ((select public.is_active()));
create policy "admin write infos" on public.info_items for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
grant select, insert, update, delete on public.team_contacts, public.info_items to authenticated;
grant all on public.team_contacts, public.info_items to service_role;
