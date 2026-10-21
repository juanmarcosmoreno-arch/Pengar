-- =============================================================================
-- Pengar — hogar compartido, segunda parte (va después de 20261021000000_pengar.sql; se pega igual, en el SQL Editor)
--
-- * Códigos de 12 letras y números (los de 8 se cambian) y un límite de códigos errados por hora: adivinar uno deja
--   de ser posible.
-- * pengar_pull: quien no es miembro recibe un error (antes, un hogar vacío: el teléfono lo tomaba como «el hogar no
--   tiene nada» y borraba lo suyo). Además devuelve la hora del servidor, para no volver a pedir lo ya recibido.
-- * Salir siendo el último: el servidor no borra el hogar hasta que la app borró los archivos (si fallan, no sale).
-- * Sacar a otro integrante (un teléfono que ya no se usa).
-- * Realtime: los avisos van por una tabla propia (pengar_signals), sin las tablas de verdad. Realtime no aplica la
--   RLS a los DELETE: con las tablas publicadas, cualquiera que escuche recibiría las claves de lo borrado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Códigos de 12 (unos 60 bits): bytes enteramente al azar del uuid (el 6 y el 8 llevan la versión y la variante)
-- -----------------------------------------------------------------------------
create or replace function public.pengar_new_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid());
  code text := '';
  i int;
begin
  foreach i in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13] loop
    code := code || substr(alphabet, get_byte(b, i) % 32 + 1, 1);
  end loop;
  return code;
end;
$$;

alter table public.pengar_households drop constraint if exists pengar_households_invite_code_check;
update public.pengar_households set invite_code = public.pengar_new_code() where char_length(invite_code) <> 12;
alter table public.pengar_households
  add constraint pengar_households_invite_code_check check (invite_code ~ '^[A-HJ-NP-Z2-9]{12}$');

-- Códigos errados de cada usuario (para el límite por hora). Nadie los lee: solo pengar_join_household
create table if not exists public.pengar_join_attempts (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists pengar_join_attempts_user_idx on public.pengar_join_attempts (user_id, at);
alter table public.pengar_join_attempts enable row level security;
revoke all on public.pengar_join_attempts from anon, authenticated;

-- Unirse: un código que no existe no devuelve nada (y se anota el intento: un error desharía la anotación). Con 20
-- errados en una hora, PT429 (PostgREST lo devuelve como 429) hasta que pase la hora
drop function if exists public.pengar_join_household(text, text);
create function public.pengar_join_household(p_code text, p_display_name text default null)
returns setof public.pengar_households
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hh public.pengar_households;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  if (select count(*) from public.pengar_join_attempts a where a.user_id = uid and a.at > now() - interval '1 hour') >= 20 then
    raise exception 'Demasiados intentos' using errcode = 'PT429';
  end if;
  -- «abcd-efgh-jkmn» o «ABCD EFGH JKMN» también valen
  select * into hh from public.pengar_households
   where invite_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if not found then
    delete from public.pengar_join_attempts a where a.at < now() - interval '1 day';
    insert into public.pengar_join_attempts (user_id) values (uid);
    return;
  end if;
  -- Volver a unirse (un reintento) no duplica: actualiza el nombre si vino uno
  insert into public.pengar_members (household_id, user_id, display_name)
  values (hh.id, uid, left(nullif(btrim(p_display_name), ''), 60))
  on conflict (household_id, user_id)
  do update set display_name = coalesce(excluded.display_name, pengar_members.display_name);
  return next hh;
end;
$$;

-- Salir. 'left': saliste y el hogar sigue. 'deleted': eras el último y el hogar se borró con sus registros.
-- 'last': sos el último y todavía no se borraron los archivos: no se sale (y el código cambia, así nadie entra
-- mientras tanto); la app borra los archivos (Storage no se borra desde SQL) y llama de nuevo con p_files_cleared.
-- 'not-member': no estabas (un reintento).
drop function if exists public.pengar_leave_household(uuid);
create function public.pengar_leave_household(p_household_id uuid, p_files_cleared boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  if not public.pengar_is_member(p_household_id) then
    return 'not-member';
  end if;
  -- De a uno: si los dos últimos salen a la vez, el segundo ve que es el último
  perform 1 from public.pengar_households where id = p_household_id for update;
  if not exists (select 1 from public.pengar_members where household_id = p_household_id and user_id <> uid) then
    if not coalesce(p_files_cleared, false) then
      update public.pengar_households set invite_code = public.pengar_new_code() where id = p_household_id;
      return 'last';
    end if;
    delete from public.pengar_households where id = p_household_id;
    return 'deleted';
  end if;
  delete from public.pengar_members where household_id = p_household_id and user_id = uid;
  return 'left';
end;
$$;

-- Sacar a otro integrante: lo puede hacer cualquier integrante (para uno mismo está salir)
create or replace function public.pengar_remove_member(p_household_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.pengar_is_member(p_household_id) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Para salir, pengar_leave_household' using errcode = '22023';
  end if;
  delete from public.pengar_members where household_id = p_household_id and user_id = p_user_id;
end;
$$;

-- Traer lo cambiado: como antes, más la hora del servidor; quien no es miembro recibe 42501 (no un hogar vacío)
drop function if exists public.pengar_pull(uuid, timestamptz, text, text, integer);
create function public.pengar_pull(
  p_household_id uuid,
  p_since timestamptz default null,
  p_after_kind text default null,
  p_after_id text default null,
  p_limit integer default 1000
)
returns table (
  household_id uuid, kind text, id text, data jsonb, updated_at timestamptz, updated_by uuid, deleted boolean,
  server_time timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not public.pengar_is_member(p_household_id) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  return query
    select r.household_id, r.kind, r.id, r.data, r.updated_at, r.updated_by, r.deleted, now()
      from public.pengar_records r
     where r.household_id = p_household_id
       and (p_since is null
            or (r.updated_at, r.kind, r.id) > (p_since, coalesce(p_after_kind, ''), coalesce(p_after_id, '')))
     order by r.updated_at, r.kind, r.id
     limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$$;

-- -----------------------------------------------------------------------------
-- Avisos para Realtime: una fila por hogar con qué cambió y quién. Sin clave foránea a propósito: nunca se borra
-- (un DELETE le llegaría a cualquiera que escuche). Los miembros la leen; la escriben solo los triggers.
-- -----------------------------------------------------------------------------
create table if not exists public.pengar_signals (
  household_id uuid primary key,
  what         text not null check (what in ('records', 'members', 'household')),
  by           uuid,
  at           timestamptz not null default now()
);
alter table public.pengar_signals enable row level security;
drop policy if exists pengar_signals_select on public.pengar_signals;
create policy pengar_signals_select on public.pengar_signals
  for select to authenticated using (public.pengar_is_member(household_id));
revoke all on public.pengar_signals from anon, authenticated;
grant select on public.pengar_signals to authenticated;

-- Una vez por envío (los registros llegan de a cientos)
create or replace function public.pengar_signal_records()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pengar_signals (household_id, what, by, at)
  select distinct n.household_id, 'records', auth.uid(), now() from new_rows n
  on conflict (household_id) do update set what = excluded.what, by = excluded.by, at = excluded.at;
  return null;
end;
$$;
drop trigger if exists pengar_records_signal_insert on public.pengar_records;
drop trigger if exists pengar_records_signal_update on public.pengar_records;
create trigger pengar_records_signal_insert after insert on public.pengar_records
  referencing new table as new_rows for each statement execute function public.pengar_signal_records();
create trigger pengar_records_signal_update after update on public.pengar_records
  referencing new table as new_rows for each statement execute function public.pengar_signal_records();

create or replace function public.pengar_signal_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pengar_signals (household_id, what, by, at)
  values (case when tg_op = 'DELETE' then old.household_id else new.household_id end, 'members', auth.uid(), now())
  on conflict (household_id) do update set what = excluded.what, by = excluded.by, at = excluded.at;
  return null;
end;
$$;
drop trigger if exists pengar_members_signal on public.pengar_members;
create trigger pengar_members_signal after insert or update or delete on public.pengar_members
  for each row execute function public.pengar_signal_members();

create or replace function public.pengar_signal_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pengar_signals (household_id, what, by, at)
  values (new.id, 'household', auth.uid(), now())
  on conflict (household_id) do update set what = excluded.what, by = excluded.by, at = excluded.at;
  return null;
end;
$$;
drop trigger if exists pengar_households_signal on public.pengar_households;
create trigger pengar_households_signal after update on public.pengar_households
  for each row execute function public.pengar_signal_household();

revoke all on function public.pengar_join_household(text, text) from public, anon;
revoke all on function public.pengar_leave_household(uuid, boolean) from public, anon;
revoke all on function public.pengar_remove_member(uuid, uuid) from public, anon;
revoke all on function public.pengar_pull(uuid, timestamptz, text, text, integer) from public, anon;
revoke all on function public.pengar_signal_records() from public, anon, authenticated;
revoke all on function public.pengar_signal_members() from public, anon, authenticated;
revoke all on function public.pengar_signal_household() from public, anon, authenticated;
grant execute on function public.pengar_join_household(text, text) to authenticated;
grant execute on function public.pengar_leave_household(uuid, boolean) to authenticated;
grant execute on function public.pengar_remove_member(uuid, uuid) to authenticated;
grant execute on function public.pengar_pull(uuid, timestamptz, text, text, integer) to authenticated;

-- Realtime: solo los avisos
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach t in array array['pengar_records', 'pengar_members', 'pengar_households'] loop
      if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime drop table public.%I', t);
      end if;
    end loop;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pengar_signals') then
      alter publication supabase_realtime add table public.pengar_signals;
    end if;
  end if;
end;
$$;
