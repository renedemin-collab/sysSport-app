-- Applied to project iictpaiwrrnpbyxvbiyl on 2026-11-27 (migration "init_schema").
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.config (key text primary key, value text not null);

-- Invitations: only invited emails (with a one-time code) can create an account
create table public.invites (
  email text primary key check (email = lower(email)),
  name text not null,
  role text not null default 'trainer' check (role in ('admin','trainer')),
  zeiterfassung text check (zeiterfassung in ('timetrack','crewmaster')),
  code text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  role text not null default 'trainer' check (role in ('admin','trainer')),
  zeiterfassung text check (zeiterfassung in ('timetrack','crewmaster')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and active)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and active and role = 'admin')
$$;

-- Block every signup whose email has no open invite; create profile from invite
create or replace function private.guard_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare inv public.invites;
begin
  select * into inv from public.invites where email = lower(new.email) and used_at is null;
  if not found then
    raise exception 'Registrierung nur mit Einladung möglich';
  end if;
  return new;
end $$;
create trigger guard_new_user before insert on auth.users
  for each row execute function private.guard_new_user();

create or replace function private.profile_from_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
declare inv public.invites;
begin
  select * into inv from public.invites where email = lower(new.email);
  insert into public.profiles (id, email, name, role, zeiterfassung)
  values (new.id, lower(new.email), inv.name, inv.role, inv.zeiterfassung)
  on conflict (id) do nothing;
  update public.invites set used_at = now() where email = lower(new.email);
  return new;
end $$;
create trigger profile_from_invite after insert on auth.users
  for each row execute function private.profile_from_invite();

-- Settings (e.g. Timetrack / Crewmaster URLs)
create table public.app_settings (key text primary key, value text not null default '');
insert into public.app_settings(key, value) values
  ('timetrack_url', ''), ('crewmaster_url', '');

-- Links: Home Assistant + tools
create table public.links (
  id uuid primary key default gen_random_uuid(),
  cat text not null check (cat in ('ha','tools')),
  title text not null,
  url text not null check (url ~* '^https://'),
  note text,
  sort int not null default 50,
  created_at timestamptz not null default now()
);

-- Library
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'Allgemein',
  note text,
  file_path text not null unique,
  file_name text not null,
  mime text,
  size bigint,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Synced data from Make (Virtuagym, HubSpot, Google Calendar)
create table public.snapshots (
  kind text primary key check (kind in ('kurse','probe','schulen','deals')),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Make pushes data here via POST /rest/v1/rpc/ingest with a shared secret (stored in private.config)
create or replace function public.ingest(secret text, kind text, data jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if secret is null or secret <> (select value from private.config where key = 'ingest_secret') then
    raise exception 'forbidden';
  end if;
  insert into public.snapshots(kind, data, updated_at) values (kind, data, now())
  on conflict (kind) do update set data = excluded.data, updated_at = now();
  return 'ok';
end $$;
revoke all on function public.ingest(text, text, jsonb) from public;
grant execute on function public.ingest(text, text, jsonb) to anon, authenticated;

-- RLS
alter table public.invites enable row level security;
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.links enable row level security;
alter table public.documents enable row level security;
alter table public.snapshots enable row level security;

create policy "admin manages invites" on public.invites for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "read own or admin all" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "admin updates profiles" on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "active read settings" on public.app_settings for select to authenticated using ((select public.is_active()));
create policy "admin write settings" on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "active read links" on public.links for select to authenticated using ((select public.is_active()));
create policy "admin insert links" on public.links for insert to authenticated with check ((select public.is_admin()));
create policy "admin update links" on public.links for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin delete links" on public.links for delete to authenticated using ((select public.is_admin()));

create policy "active read docs" on public.documents for select to authenticated using ((select public.is_active()));
create policy "admin insert docs" on public.documents for insert to authenticated with check ((select public.is_admin()));
create policy "admin update docs" on public.documents for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin delete docs" on public.documents for delete to authenticated using ((select public.is_admin()));

create policy "active read snapshots" on public.snapshots for select to authenticated using ((select public.is_active()));

-- Storage bucket for the library (private)
insert into storage.buckets (id, name, public, file_size_limit)
values ('bibliothek', 'bibliothek', false, 52428800)
on conflict (id) do nothing;

create policy "active read library" on storage.objects for select to authenticated
  using (bucket_id = 'bibliothek' and (select public.is_active()));
create policy "admin upload library" on storage.objects for insert to authenticated
  with check (bucket_id = 'bibliothek' and (select public.is_admin()));
create policy "admin delete library" on storage.objects for delete to authenticated
  using (bucket_id = 'bibliothek' and (select public.is_admin()));
