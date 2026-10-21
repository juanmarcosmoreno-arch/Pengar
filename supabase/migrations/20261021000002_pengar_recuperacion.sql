-- =============================================================================
-- Pengar — hogar compartido, tercera parte: volver a entrar desde otro teléfono (va después de
-- 20261021000001_pengar_revision.sql; se pega igual, en el SQL Editor; se puede correr más de una vez)
--
-- * Cada integrante tiene un id que no cambia (member_id): es el de «Anotado por» (Movement.createdBy). Los que ya
--   estaban quedan con su user_id, que es lo que ya dicen sus movimientos.
-- * La llave para volver a entrar: al crear o unirse, el teléfono manda un secreto al azar y el servidor guarda solo su
--   hash (sha256). El secreto queda en ese teléfono y en sus respaldos, nunca en el hogar. Unirse con el código y la
--   llave de un integrante del hogar hace que ese integrante pase a ser el usuario nuevo (siguen su nombre y su
--   historia): no se suma otro, y el teléfono de antes queda afuera.
-- * El hash no lo lee nadie: los integrantes ven las columnas de siempre (más member_id).
-- =============================================================================

alter table public.pengar_members add column if not exists member_id uuid;
update public.pengar_members set member_id = user_id where member_id is null;

-- Lo que entra sin member_id (por ejemplo, con una función de antes) toma el user_id
create or replace function public.pengar_member_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.member_id := coalesce(new.member_id, new.user_id);
  return new;
end;
$$;
drop trigger if exists pengar_members_defaults on public.pengar_members;
create trigger pengar_members_defaults before insert on public.pengar_members
  for each row execute function public.pengar_member_defaults();

alter table public.pengar_members alter column member_id set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pengar_members_member_key') then
    alter table public.pengar_members add constraint pengar_members_member_key unique (household_id, member_id);
  end if;
end;
$$;

alter table public.pengar_members add column if not exists recovery_hash text;
alter table public.pengar_members drop constraint if exists pengar_members_recovery_hash_check;
alter table public.pengar_members add constraint pengar_members_recovery_hash_check check (recovery_hash ~ '^[0-9a-f]{64}$');
create unique index if not exists pengar_members_recovery_idx
  on public.pengar_members (household_id, recovery_hash) where recovery_hash is not null;

-- Los integrantes se ven sin el hash
revoke select on public.pengar_members from authenticated;
grant select (household_id, user_id, member_id, display_name, joined_at) on public.pengar_members to authenticated;

-- El hash de la llave (null sin llave). Una que no tiene el largo de las que arma la app no sirve: 22023
create or replace function public.pengar_recovery_hash(p_token text)
returns text
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_token is null then
    return null;
  end if;
  if char_length(p_token) not between 32 and 200 then
    raise exception 'Llave inválida' using errcode = '22023';
  end if;
  return encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
end;
$$;

-- -----------------------------------------------------------------------------
-- Crear: como antes, con la llave de quien lo crea
-- -----------------------------------------------------------------------------
drop function if exists public.pengar_create_household(text, text);
create or replace function public.pengar_create_household(p_name text, p_display_name text default null, p_token text default null)
returns public.pengar_households
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hh public.pengar_households;
  h text;
  tries int := 0;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  h := public.pengar_recovery_hash(p_token);
  loop
    begin
      insert into public.pengar_households (name)
      values (coalesce(left(nullif(btrim(p_name), ''), 80), 'Casa'))
      returning * into hh;
      exit;
    exception when unique_violation then
      -- El código salió repetido: se prueba con otro
      tries := tries + 1;
      if tries >= 5 then raise; end if;
    end;
  end loop;
  insert into public.pengar_members (household_id, user_id, member_id, display_name, recovery_hash)
  values (hh.id, uid, uid, left(nullif(btrim(p_display_name), ''), 60), h);
  return hh;
end;
$$;

-- -----------------------------------------------------------------------------
-- Unirse: como antes (un código que no existe no devuelve nada y cuenta para el límite por hora). Con la llave de un
-- integrante de ese hogar, ese integrante pasa a ser este usuario (reclaimed). Si no, se suma uno nuevo con esa llave.
-- Repetirlo no duplica
-- -----------------------------------------------------------------------------
drop function if exists public.pengar_join_household(text, text);
create or replace function public.pengar_join_household(p_code text, p_display_name text default null, p_token text default null)
returns table (id uuid, name text, invite_code text, member_id uuid, display_name text, reclaimed boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  hh public.pengar_households;
  m public.pengar_members;
  h text;
  nm text := left(nullif(btrim(p_display_name), ''), 60);
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  h := public.pengar_recovery_hash(p_token);
  if (select count(*) from public.pengar_join_attempts a where a.user_id = uid and a.at > now() - interval '1 hour') >= 20 then
    raise exception 'Demasiados intentos' using errcode = 'PT429';
  end if;
  -- «abcd-efgh-jkmn» o «ABCD EFGH JKMN» también valen
  select * into hh from public.pengar_households x
   where x.invite_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if not found then
    delete from public.pengar_join_attempts a where a.at < now() - interval '1 day';
    insert into public.pengar_join_attempts (user_id) values (uid);
    return;
  end if;
  -- De a uno por hogar: dos teléfonos que entran a la vez con la misma llave no se pisan
  perform 1 from public.pengar_households x where x.id = hh.id for update;
  if h is not null then
    select * into m from public.pengar_members pm where pm.household_id = hh.id and pm.recovery_hash = h;
    if found then
      if m.user_id <> uid then
        -- Si este teléfono ya había entrado sin la llave, es la misma persona: queda un solo integrante
        delete from public.pengar_members pm where pm.household_id = hh.id and pm.user_id = uid;
        update public.pengar_members pm set user_id = uid, display_name = coalesce(nm, pm.display_name)
         where pm.household_id = hh.id and pm.member_id = m.member_id
         returning * into m;
      elsif nm is not null then
        update public.pengar_members pm set display_name = nm
         where pm.household_id = hh.id and pm.user_id = uid
         returning * into m;
      end if;
      return query select hh.id, hh.name, hh.invite_code, m.member_id, m.display_name, true;
      return;
    end if;
  end if;
  insert into public.pengar_members as pm (household_id, user_id, member_id, display_name, recovery_hash)
  values (hh.id, uid, uid, nm, h)
  on conflict (household_id, user_id)
  do update set display_name = coalesce(excluded.display_name, pm.display_name),
                recovery_hash = coalesce(excluded.recovery_hash, pm.recovery_hash)
  returning * into m;
  return query select hh.id, hh.name, hh.invite_code, m.member_id, m.display_name, false;
end;
$$;

-- -----------------------------------------------------------------------------
-- La llave de quien ya estaba en el hogar (antes de esta migración, o si el teléfono perdió la suya): la cambia por otra
-- -----------------------------------------------------------------------------
create or replace function public.pengar_set_recovery(p_household_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  h text;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '28000';
  end if;
  h := public.pengar_recovery_hash(p_token);
  if h is null then
    raise exception 'Falta la llave' using errcode = '22023';
  end if;
  update public.pengar_members set recovery_hash = h where household_id = p_household_id and user_id = uid;
  if not found then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.pengar_member_defaults() from public, anon, authenticated;
revoke all on function public.pengar_recovery_hash(text) from public, anon, authenticated;
revoke all on function public.pengar_create_household(text, text, text) from public, anon;
revoke all on function public.pengar_join_household(text, text, text) from public, anon;
revoke all on function public.pengar_set_recovery(uuid, text) from public, anon;
grant execute on function public.pengar_create_household(text, text, text) to authenticated;
grant execute on function public.pengar_join_household(text, text, text) to authenticated;
grant execute on function public.pengar_set_recovery(uuid, text) to authenticated;
