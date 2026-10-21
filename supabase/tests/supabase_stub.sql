-- Lo mínimo del entorno de Supabase para probar la migración en un Postgres pelado (supabase/tests/run-local.sh).
-- NO se usa en Supabase real: ahí ya existen los roles, el esquema auth, Storage y la publicación de Realtime.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Como Supabase: todo lo nuevo de public queda para anon y authenticated (la migración tiene que sacarlo)
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;

-- Storage: los buckets y los archivos, con RLS (las políticas las pone cada app)
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null,
  owner uuid default auth.uid(), unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant all on storage.objects to authenticated;
-- Otra app en el mismo proyecto (como Kvar), con carpetas que no son uuid
insert into storage.buckets (id, name) values ('otra-app', 'otra-app');
insert into storage.objects (bucket_id, name) values ('otra-app', 'no-es-un-uuid/foto.png');
create policy otra_app_all on storage.objects for all to authenticated using (bucket_id = 'otra-app') with check (bucket_id = 'otra-app');

create publication supabase_realtime;
