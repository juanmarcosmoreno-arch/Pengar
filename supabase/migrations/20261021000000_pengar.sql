-- =============================================================================
-- Pengar — hogar compartido
-- Puede ir en el mismo proyecto de Supabase que Kvar: todo lleva el prefijo pengar_ (tablas, funciones, políticas y
-- el bucket) y no toca nada de Kvar. Se aplica pegándolo en el SQL Editor del proyecto (ver README).
--
-- Los datos de la app viajan como registros sueltos (kind, id, data) con «gana el último» por updated_at, que pone
-- el servidor. Borrar es una lápida (deleted = true): así los demás teléfonos se enteran. Ver src/domain/sync.ts
-- y src/lib/sync.ts.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Código de invitación: 8 letras y números, sin los que se confunden (I, O, 0, 1).
-- gen_random_uuid() es del núcleo de Postgres: no hace falta pgcrypto (que en Supabase vive en otro esquema).
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
  -- Bytes enteramente al azar (el 6 y el 8 llevan la versión y la variante del uuid). 256 es múltiplo de 32: parejo
  foreach i in array array[0, 1, 2, 3, 4, 5, 10, 11] loop
    code := code || substr(alphabet, get_byte(b, i) % 32 + 1, 1);
  end loop;
  return code;
end;
$$;

-- -----------------------------------------------------------------------------
-- Hogares, miembros y registros
-- -----------------------------------------------------------------------------
create table public.pengar_households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  invite_code text not null unique default public.pengar_new_code() check (invite_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at  timestamptz not null default now()
);

create table public.pengar_members (
  household_id uuid not null references public.pengar_households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index pengar_members_user_idx on public.pengar_members (user_id);

create table public.pengar_records (
  household_id uuid not null references public.pengar_households (id) on delete cascade,
  kind         text not null check (kind in ('category', 'rubro', 'movement', 'invoice', 'goal', 'recurring', 'settings')),
  id           text not null check (char_length(id) between 1 and 100),
  data         jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 262144),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  deleted      boolean not null default false,
  primary key (household_id, kind, id)
);
-- Para traer lo cambiado desde un momento, en orden y por páginas (pengar_pull)
create index pengar_records_updated_idx on public.pengar_records (household_id, updated_at, kind, id);

-- La hora y quién lo cambió los pone el servidor (la hora del teléfono puede estar mal)
create or replace function public.pengar_touch_record()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger pengar_records_touch before insert or update on public.pengar_records
  for each row execute function public.pengar_touch_record();

-- Usada por las políticas. security definer para no caer en la RLS de pengar_members (recursión).
create or replace function public.pengar_is_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.pengar_members m
    where m.household_id = p_household_id and m.user_id = auth.uid()
  );
$$;

-- Lo mismo para los archivos: la primera carpeta es el hogar. Compara como texto: una ruta que no empieza con un
-- uuid da false en vez de un error (la política se evalúa también con archivos de otros buckets, como los de Kvar)
create or replace function public.pengar_can_use_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.pengar_members m
    where m.user_id = auth.uid() and m.household_id::text = split_part(p_name, '/', 1)
  );
$$;

-- =============================================================================
-- Row Level Security: cada hogar ve y toca solo lo suyo
-- =============================================================================
alter table public.pengar_households enable row level security;
alter table public.pengar_members    enable row level security;
alter table public.pengar_records    enable row level security;

-- Hogares: se crean y se deja el código nuevo por las funciones de abajo; los miembros pueden cambiar el nombre.
create policy pengar_households_select on public.pengar_households
  for select to authenticated using (public.pengar_is_member(id));
create policy pengar_households_update on public.pengar_households
  for update to authenticated using (public.pengar_is_member(id)) with check (public.pengar_is_member(id));

-- Miembros: se ven los del propio hogar; cada uno cambia su nombre. Entrar y salir, por las funciones.
create policy pengar_members_select on public.pengar_members
  for select to authenticated using (public.pengar_is_member(household_id));
create policy pengar_members_update_self on public.pengar_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Registros: los miembros leen, agregan y cambian. No se borran (lápidas); se van con el hogar.
create policy pengar_records_select on public.pengar_records
  for select to authenticated using (public.pengar_is_member(household_id));
create policy pengar_records_insert on public.pengar_records
  for insert to authenticated with check (public.pengar_is_member(household_id));
create policy pengar_records_update on public.pengar_records
  for update to authenticated
  using (public.pengar_is_member(household_id)) with check (public.pengar_is_member(household_id));

-- Supabase da todo a anon y authenticated por defecto: se deja solo lo necesario (y por columna donde importa)
revoke all on public.pengar_households, public.pengar_members, public.pengar_records from anon, authenticated;
grant select on public.pengar_households to authenticated;
grant update (name) on public.pengar_households to authenticated;
grant select on public.pengar_members to authenticated;
grant update (display_name) on public.pengar_members to authenticated;
grant select, insert, update on public.pengar_records to authenticated;

-- =============================================================================
-- Funciones: crear, unirse, código nuevo, salir y traer lo cambiado
-- =============================================================================
create or replace function public.pengar_create_household(p_name text, p_display_name text default null)
returns public.pengar_households
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hh public.pengar_households;
  tries int := 0;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  loop
    begin
      insert into public.pengar_households (name)
      values (coalesce(left(nullif(btrim(p_name), ''), 80), 'Casa'))
      returning * into hh;
      exit;
    exception when unique_violation then
      -- El código salió repetido (1 en un billón): se prueba con otro
      tries := tries + 1;
      if tries >= 5 then raise; end if;
    end;
  end loop;
  insert into public.pengar_members (household_id, user_id, display_name)
  values (hh.id, uid, left(nullif(btrim(p_display_name), ''), 60));
  return hh;
end;
$$;

create or replace function public.pengar_join_household(p_code text, p_display_name text default null)
returns public.pengar_households
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
  -- «abcd-efgh» o «ABCD EFGH» también valen
  select * into hh from public.pengar_households
   where invite_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if not found then
    raise exception 'Código inválido' using errcode = 'P0002';
  end if;
  -- Volver a unirse (un reintento) no duplica: actualiza el nombre si vino uno
  insert into public.pengar_members (household_id, user_id, display_name)
  values (hh.id, uid, left(nullif(btrim(p_display_name), ''), 60))
  on conflict (household_id, user_id)
  do update set display_name = coalesce(excluded.display_name, pengar_members.display_name);
  return hh;
end;
$$;

create or replace function public.pengar_regenerate_code(p_household_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  code text;
  tries int := 0;
begin
  if not public.pengar_is_member(p_household_id) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  loop
    begin
      code := public.pengar_new_code();
      update public.pengar_households set invite_code = code where id = p_household_id;
      return code;
    exception when unique_violation then
      tries := tries + 1;
      if tries >= 5 then raise; end if;
    end;
  end loop;
end;
$$;

-- Salir: true si eras el último y el hogar se borró con todos sus registros. Los archivos del bucket los borra
-- antes la app (Storage no se borra desde SQL). Salir de un hogar donde no estás no hace nada (reintentos).
create or replace function public.pengar_leave_household(p_household_id uuid)
returns boolean
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
    return false;
  end if;
  -- De a uno: si los dos últimos salen a la vez, el segundo ve que no queda nadie y borra el hogar
  perform 1 from public.pengar_households where id = p_household_id for update;
  delete from public.pengar_members where household_id = p_household_id and user_id = uid;
  if not exists (select 1 from public.pengar_members where household_id = p_household_id) then
    delete from public.pengar_households where id = p_household_id;
    return true;
  end if;
  return false;
end;
$$;

-- Lo cambiado desde p_since (incluido), en orden y por páginas: la página siguiente sigue después del último
-- (updated_at, kind, id). Varios registros comparten updated_at (los de un mismo envío): por eso el desempate.
-- security invoker: la RLS filtra (quien no es miembro recibe nada).
create or replace function public.pengar_pull(
  p_household_id uuid,
  p_since timestamptz default null,
  p_after_kind text default null,
  p_after_id text default null,
  p_limit integer default 1000
)
returns setof public.pengar_records
language sql
stable
security invoker
set search_path = public
as $$
  select r.*
    from public.pengar_records r
   where r.household_id = p_household_id
     and (p_since is null
          or (r.updated_at, r.kind, r.id) > (p_since, coalesce(p_after_kind, ''), coalesce(p_after_id, '')))
   order by r.updated_at, r.kind, r.id
   limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

revoke all on function public.pengar_new_code() from public, anon, authenticated;
revoke all on function public.pengar_touch_record() from public, anon, authenticated;
revoke all on function public.pengar_is_member(uuid) from public, anon;
revoke all on function public.pengar_can_use_file(text) from public, anon;
revoke all on function public.pengar_create_household(text, text) from public, anon;
revoke all on function public.pengar_join_household(text, text) from public, anon;
revoke all on function public.pengar_regenerate_code(uuid) from public, anon;
revoke all on function public.pengar_leave_household(uuid) from public, anon;
revoke all on function public.pengar_pull(uuid, timestamptz, text, text, integer) from public, anon;
grant execute on function public.pengar_is_member(uuid) to authenticated;
grant execute on function public.pengar_can_use_file(text) to authenticated;
grant execute on function public.pengar_create_household(text, text) to authenticated;
grant execute on function public.pengar_join_household(text, text) to authenticated;
grant execute on function public.pengar_regenerate_code(uuid) to authenticated;
grant execute on function public.pengar_leave_household(uuid) to authenticated;
grant execute on function public.pengar_pull(uuid, timestamptz, text, text, integer) to authenticated;

-- =============================================================================
-- Storage: fotos y PDF de facturas y estados de cuenta. Bucket privado: pengar-files/<household_id>/<invoice id>
-- =============================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('pengar-files', 'pengar-files', false, 26214400)
    on conflict (id) do nothing;

    execute $p$
      create policy pengar_files_member on storage.objects for all to authenticated
      using (bucket_id = 'pengar-files' and public.pengar_can_use_file(name))
      with check (bucket_id = 'pengar-files' and public.pengar_can_use_file(name))
    $p$;
  end if;
end;
$$;

-- =============================================================================
-- Realtime: avisa a los demás teléfonos que hay algo nuevo (la app después trae lo cambiado con pengar_pull)
-- =============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    alter publication supabase_realtime add table
      public.pengar_records, public.pengar_members, public.pengar_households;
  end if;
end;
$$;
-- Realtime respeta la RLS en INSERT y UPDATE (los únicos que escucha la app). Los registros nunca se borran.
