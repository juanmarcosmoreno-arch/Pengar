-- =============================================================================
-- Pengar, hogar compartido (cuarta parte): integrantes que vuelven (va después de
-- 20261021000002_pengar_recuperacion.sql; se pega igual, en el SQL Editor; se puede correr más de una vez)
--
-- * El teléfono de antes de alguien que volvió a entrar desde otro (con su llave) puede sumarse como integrante nuevo:
--   su usuario ya es el member_id de ese integrante, así que el nuevo lleva otro id (antes chocaba: 23505).
-- * A quien sacaron con «Sacar» y vuelve con su llave, vuelve como el mismo integrante (su member_id: lo que anotó
--   sigue siendo suyo), sin desplazar a nadie. Para eso se guarda su id y el hash de su llave al sacarlo
--   (pengar_departed, que los teléfonos no leen). Al salir por cuenta propia no: la app borra la llave.
-- =============================================================================

create table if not exists public.pengar_departed (
  household_id  uuid not null references public.pengar_households (id) on delete cascade,
  member_id     uuid not null,
  recovery_hash text not null check (recovery_hash ~ '^[0-9a-f]{64}$'),
  display_name  text,
  left_at       timestamptz not null default now(),
  primary key (household_id, member_id)
);
alter table public.pengar_departed enable row level security;
-- Sin políticas ni permisos: solo lo usan las funciones de acá
revoke all on public.pengar_departed from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Sacar a otro integrante: como antes, y queda su id con el hash de su llave (para que vuelva como el mismo)
-- -----------------------------------------------------------------------------
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
  insert into public.pengar_departed (household_id, member_id, recovery_hash, display_name)
  select m.household_id, m.member_id, m.recovery_hash, m.display_name
    from public.pengar_members m
   where m.household_id = p_household_id and m.user_id = p_user_id and m.recovery_hash is not null
  on conflict (household_id, member_id) do update
    set recovery_hash = excluded.recovery_hash, display_name = excluded.display_name, left_at = now();
  delete from public.pengar_members where household_id = p_household_id and user_id = p_user_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Unirse: como antes (20261021000002). Con la llave de un integrante, ese integrante pasa a ser este usuario; con la de
-- alguien a quien sacaron, vuelve con su id. Si no, un integrante nuevo: con el id de su usuario, salvo que ya sea el de
-- otro integrante (entonces uno nuevo)
-- -----------------------------------------------------------------------------
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
  gone public.pengar_departed;
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
    -- Lo habían sacado y vuelve con su llave: el mismo integrante (si su id está libre), sin desplazar a nadie
    select * into gone from public.pengar_departed d where d.household_id = hh.id and d.recovery_hash = h limit 1;
    if found and not exists (select 1 from public.pengar_members pm where pm.household_id = hh.id and pm.member_id = gone.member_id) then
      delete from public.pengar_members pm where pm.household_id = hh.id and pm.user_id = uid;
      insert into public.pengar_members (household_id, user_id, member_id, display_name, recovery_hash)
      values (hh.id, uid, gone.member_id, coalesce(nm, gone.display_name), h)
      returning * into m;
      delete from public.pengar_departed d where d.household_id = hh.id and d.member_id = gone.member_id;
      return query select hh.id, hh.name, hh.invite_code, m.member_id, m.display_name, true;
      return;
    end if;
  end if;
  insert into public.pengar_members as pm (household_id, user_id, member_id, display_name, recovery_hash)
  values (
    hh.id, uid,
    -- El usuario de este teléfono ya es el id de otro integrante (alguien que volvió a entrar desde otro teléfono con la
    -- llave de este): otro id
    case when exists (select 1 from public.pengar_members x where x.household_id = hh.id and x.member_id = uid) then gen_random_uuid() else uid end,
    nm, h
  )
  on conflict (household_id, user_id)
  do update set display_name = coalesce(excluded.display_name, pm.display_name),
                recovery_hash = coalesce(excluded.recovery_hash, pm.recovery_hash)
  returning * into m;
  -- Su id ya no es el de alguien que se fue
  delete from public.pengar_departed d where d.household_id = hh.id and d.member_id = m.member_id;
  return query select hh.id, hh.name, hh.invite_code, m.member_id, m.display_name, false;
end;
$$;

revoke all on function public.pengar_remove_member(uuid, uuid) from public, anon;
revoke all on function public.pengar_join_household(text, text, text) from public, anon;
grant execute on function public.pengar_remove_member(uuid, uuid) to authenticated;
grant execute on function public.pengar_join_household(text, text, text) to authenticated;
