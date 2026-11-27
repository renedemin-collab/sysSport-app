-- "kind" was ambiguous inside ingest(); this project also revokes default table privileges, so grant explicitly.
create or replace function public.ingest(secret text, kind text, data jsonb) returns text
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare k text := ingest.kind; d jsonb := ingest.data;
begin
  if ingest.secret is null or ingest.secret <> (select c.value from private.config c where c.key = 'ingest_secret') then
    raise exception 'forbidden';
  end if;
  insert into public.snapshots as s (kind, data, updated_at) values (k, d, now())
  on conflict (kind) do update set data = excluded.data, updated_at = now();
  return 'ok';
end $$;
revoke all on function public.ingest(text, text, jsonb) from public;
grant execute on function public.ingest(text, text, jsonb) to anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant select on public.profiles, public.app_settings, public.links, public.documents, public.snapshots to authenticated;
grant update on public.profiles, public.app_settings to authenticated;
grant insert, update, delete on public.links, public.documents to authenticated;
grant select, insert, update, delete on public.invites to authenticated;
grant all on public.invites, public.profiles, public.app_settings, public.links, public.documents, public.snapshots to service_role;
grant execute on function public.is_active(), public.is_admin() to authenticated, service_role;
revoke execute on function public.is_active(), public.is_admin() from public, anon;
