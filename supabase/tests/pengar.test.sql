-- Pruebas de la migración del hogar compartido: aislamiento entre hogares, funciones y archivos.
-- Corre con: npm run test:db   (Postgres 15+ local; arma un Supabase mínimo con supabase_stub.sql)
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'ana@ejemplo.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bruno@ejemplo.com'),
  ('00000000-0000-0000-0000-00000000000c', 'carla@ejemplo.com'),
  ('00000000-0000-0000-0000-00000000000d', 'dani@ejemplo.com'),
  ('00000000-0000-0000-0000-00000000000e', 'dani-telefono-nuevo@ejemplo.com'),
  ('00000000-0000-0000-0000-00000000000f', 'dani-otro-telefono@ejemplo.com');

-- Sin sesión (anon) no se puede nada
set local role anon;
do $$ begin
  begin
    perform public.pengar_create_household('Casa', 'Nadie');
    raise exception 'anon no debería poder crear un hogar';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.pengar_records;
    raise exception 'anon no debería leer registros';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role authenticated;

-- Ana crea un hogar (con su llave para volver a entrar)
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select id as hh, invite_code as code from public.pengar_create_household('  Casa de Ana  ', 'Ana', 'llave-de-ana-0123456789abcdefghijklmnop') \gset
select set_config('t.hh', :'hh', true) as x \gset ignored_
select set_config('t.code', :'code', true) as x \gset ignored_
do $$ begin
  assert current_setting('t.code') ~ '^[A-HJ-NP-Z2-9]{12}$', 'código de 12 sin letras ambiguas';
  assert (select name from public.pengar_households) = 'Casa de Ana', 'nombre sin espacios de más';
  assert (select count(*) from public.pengar_members) = 1, 'Ana es miembro';
  assert (select display_name from public.pengar_members) = 'Ana', 'con su nombre';
  assert (select member_id from public.pengar_members) = auth.uid(), 'su id de integrante es el de su usuario';
  -- El hash de la llave no lo lee nadie (tampoco ella) ni se cambia a mano
  begin
    perform recovery_hash from public.pengar_members;
    raise exception 'el hash de la llave no se tiene que poder leer';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pengar_members set recovery_hash = repeat('0', 64);
    raise exception 'el hash no se cambia a mano';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  assert (select recovery_hash from public.pengar_members where user_id = '00000000-0000-0000-0000-00000000000a')
    = encode(sha256(convert_to('llave-de-ana-0123456789abcdefghijklmnop', 'UTF8')), 'hex'), 'se guarda el hash, no la llave';
end $$;
set local role authenticated;

-- Sus registros: la hora y quién lo cambió los pone el servidor (aunque el teléfono mande otra cosa)
insert into public.pengar_records (household_id, kind, id, data, updated_at, updated_by)
values (current_setting('t.hh')::uuid, 'movement', 'm1', '{"id":"m1","amount":100}', '2000-01-01', '00000000-0000-0000-0000-00000000000c'),
       (current_setting('t.hh')::uuid, 'settings', 'hogar', '{"learned":{}}', default, default);
do $$ begin
  assert (select count(*) from public.pengar_records) = 2, 'dos registros';
  assert (select what from public.pengar_signals where household_id = current_setting('t.hh')::uuid) = 'records', 'aviso para Realtime';
  assert (select updated_at from public.pengar_records where id = 'm1') > now() - interval '1 minute', 'hora del servidor';
  assert (select updated_by from public.pengar_records where id = 'm1') = auth.uid(), 'quién lo cambió';
  begin
    insert into public.pengar_records (household_id, kind, id) values (current_setting('t.hh')::uuid, 'otra-cosa', 'x');
    raise exception 'debería haber fallado';
  exception when check_violation then null;
  end;
end $$;

-- Bruno todavía no es miembro: no ve nada ni puede escribir en el hogar de Ana
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.pengar_households) = 0, 'Bruno no ve el hogar';
  assert (select count(*) from public.pengar_records) = 0, 'ni sus registros';
  assert (select count(*) from public.pengar_signals) = 0, 'ni sus avisos';
  begin
    perform public.pengar_pull(current_setting('t.hh')::uuid);
    raise exception 'pengar_pull de quien no es miembro tiene que fallar (no devolver un hogar vacío)';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.pengar_records (household_id, kind, id) values (current_setting('t.hh')::uuid, 'movement', 'intruso');
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.pengar_regenerate_code(current_setting('t.hh')::uuid);
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.pengar_join_household('ZZZZZZZZZZZZ', 'Bruno')) = 0, 'un código que no existe no devuelve nada';
  begin
    perform public.pengar_remove_member(current_setting('t.hh')::uuid, '00000000-0000-0000-0000-00000000000a');
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  assert public.pengar_leave_household(current_setting('t.hh')::uuid) = 'not-member', 'salir de donde no está no hace nada';
end $$;

-- Bruno se une con el código escrito a su manera; repetirlo no duplica
select 1 as x from public.pengar_join_household(lower(substr(current_setting('t.code'), 1, 4)) || '-' || substr(current_setting('t.code'), 5), 'Bruno') \gset ignored_
select 1 as x from public.pengar_join_household(current_setting('t.code'), null) \gset ignored_
do $$ begin
  assert (select count(*) from public.pengar_members) = 2, 'Ana y Bruno';
  assert (select display_name from public.pengar_members where user_id = auth.uid()) = 'Bruno', 'el reintento sin nombre no lo borra';
  assert (select count(*) from public.pengar_records) = 2, 'Bruno ve los registros';
end $$;

-- Bruno edita el movimiento (upsert como el de la app) y agrega otro
insert into public.pengar_records (household_id, kind, id, data, deleted)
values (current_setting('t.hh')::uuid, 'movement', 'm1', '{"id":"m1","amount":200}', false),
       (current_setting('t.hh')::uuid, 'movement', 'm2', '{"id":"m2","amount":50}', false)
on conflict (household_id, kind, id) do update set data = excluded.data, deleted = excluded.deleted;
do $$ begin
  assert (select data ->> 'amount' from public.pengar_records where id = 'm1') = '200', 'gana el último';
  assert (select updated_by from public.pengar_records where id = 'm1') = auth.uid(), 'cambiado por Bruno';
end $$;

-- Borrar es una lápida; borrar de verdad no se puede
update public.pengar_records set deleted = true, data = '{}' where id = 'm2';
do $$ begin
  begin
    delete from public.pengar_records;
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.pengar_records) = 3, 'nada se borra';
  assert (select deleted from public.pengar_records where id = 'm2'), 'lápida';
end $$;

-- Bruno cambia su nombre, no el de Ana; el código no se toca a mano
update public.pengar_members set display_name = 'Bruno M.';
do $$ begin
  assert (select display_name from public.pengar_members where user_id = auth.uid()) = 'Bruno M.', 'su nombre';
  assert (select display_name from public.pengar_members where user_id <> auth.uid()) = 'Ana', 'el de Ana igual';
  begin
    update public.pengar_households set invite_code = 'AAAAAAAA';
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.pengar_members (household_id, user_id) values (current_setting('t.hh')::uuid, '00000000-0000-0000-0000-00000000000c');
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
end $$;
update public.pengar_households set name = 'Casa de Ana y Bruno';

-- pengar_pull por páginas: un envío grande comparte la hora (now() es del envío): el desempate es (kind, id)
insert into public.pengar_records (household_id, kind, id, data)
select current_setting('t.hh')::uuid, 'movement', 'lote' || i, jsonb_build_object('i', i) from generate_series(1, 7) i;
do $$
declare
  seen text[] := '{}';
  page record;
  last_at timestamptz := null;
  last_kind text := null;
  last_id text := null;
  n int;
begin
  loop
    n := 0;
    for page in select * from public.pengar_pull(current_setting('t.hh')::uuid, coalesce(last_at, '-infinity'), last_kind, last_id, 3) loop
      seen := seen || (page.kind || ':' || page.id);
      last_at := page.updated_at; last_kind := page.kind; last_id := page.id;
      n := n + 1;
    end loop;
    exit when n < 3;
  end loop;
  assert array_length(seen, 1) = 10, 'los 10 registros, sin repetir: ' || array_to_string(seen, ',');
  assert (select count(distinct x) from unnest(seen) x) = 10, 'sin repetidos';
  assert (select count(*) from public.pengar_pull(current_setting('t.hh')::uuid, now() + interval '1 hour')) = 0, 'nada después';
  assert (select count(*) from public.pengar_pull(current_setting('t.hh')::uuid, null, null, null, 5000)) = 10, 'sin desde: todo';
end $$;

-- Archivos: los del hogar, en su carpeta
insert into storage.objects (bucket_id, name) values ('pengar-files', current_setting('t.hh') || '/f1');
do $$ begin
  assert (select count(*) from storage.objects where bucket_id = 'pengar-files') = 1, 'Bruno ve el archivo';
  assert (select count(*) from storage.objects where bucket_id = 'otra-app') = 1, 'la otra app sigue andando (carpetas que no son uuid)';
end $$;

-- Carla, en su propio hogar, no ve ni toca nada del de Ana
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select id as hh_carla from public.pengar_create_household('', null) \gset
do $$ begin
  assert (select name from public.pengar_households) = 'Casa', 'sin nombre: «Casa»';
  assert (select count(*) from public.pengar_households) = 1, 'Carla ve solo su hogar';
  assert (select count(*) from public.pengar_members) = 1, 'y solo sus miembros';
  assert (select count(*) from public.pengar_records) = 0, 'ningún registro ajeno';
  assert (select count(*) from storage.objects where bucket_id = 'pengar-files') = 0, 'ningún archivo ajeno';
  update public.pengar_records set data = '{}' where household_id = current_setting('t.hh')::uuid;
  begin
    insert into storage.objects (bucket_id, name) values ('pengar-files', current_setting('t.hh') || '/f2');
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('pengar-files', 'cualquier-cosa/f3');
    raise exception 'debería haber fallado';
  exception when insufficient_privilege then null;
  end;
end $$;
insert into storage.objects (bucket_id, name) values ('pengar-files', :'hh_carla' || '/f9');

-- Ana pide un código nuevo: el viejo deja de servir
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select public.pengar_regenerate_code(current_setting('t.hh')::uuid) as newcode \gset
select set_config('t.newcode', :'newcode', true) as x \gset ignored_
do $$ begin
  assert (select invite_code from public.pengar_households) <> current_setting('t.code'), 'código nuevo';
  assert (select data ->> 'amount' from public.pengar_records where id = 'm1') = '200', 'Carla no pudo tocar nada';
  assert (select name from public.pengar_households) = 'Casa de Ana y Bruno', 'nombre cambiado por Bruno';
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$ begin
  assert (select count(*) from public.pengar_join_household(current_setting('t.code'), 'Carla')) = 0, 'el código viejo no sirve';
end $$;

-- Probar códigos al azar tiene un límite: 20 errados por hora
do $$ begin
  -- Carla ya erró uno (el código viejo)
  for i in 1..19 loop
    assert (select count(*) from public.pengar_join_household('ABCDEFGHJKLM', null)) = 0, 'código errado';
  end loop;
  begin
    perform public.pengar_join_household('ABCDEFGHJKLN', null);
    raise exception 'debería haber fallado';
  exception when sqlstate 'PT429' then null;
  end;
end $$;

-- Dani entra con su llave
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
do $$
declare
  r record;
begin
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Dani', 'llave-de-dani-0123456789abcdefghijklmnop');
  assert not r.reclaimed, 'la primera vez es un integrante nuevo';
  assert r.member_id = auth.uid() and r.display_name = 'Dani', 'con su id y su nombre';
  insert into public.pengar_records (household_id, kind, id, data)
  values (current_setting('t.hh')::uuid, 'movement', 'de-dani', jsonb_build_object('createdBy', r.member_id));
  begin
    perform public.pengar_join_household(current_setting('t.newcode'), null, 'corta');
    raise exception 'una llave corta no sirve';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Dani cambia de teléfono (otro usuario) y entra con el código y la misma llave (la de un respaldo): vuelve a ser Dani.
-- No se suma otro integrante, sigue su id (lo que anotó dice «Anotado por Dani») y el teléfono de antes queda afuera
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
do $$
declare
  r record;
begin
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Dani', 'llave-de-dani-0123456789abcdefghijklmnop');
  assert r.reclaimed, 'volvió a entrar con su llave';
  assert r.member_id = '00000000-0000-0000-0000-00000000000d' and r.display_name = 'Dani', 'es el mismo integrante, con su nombre';
  assert r.id = current_setting('t.hh')::uuid, 'en el mismo hogar';
  assert (select count(*) from public.pengar_members) = 3, 'Ana, Bruno y Dani: no se sumó otro';
  assert (select user_id from public.pengar_members where member_id = '00000000-0000-0000-0000-00000000000d') = auth.uid(), 'Dani es este teléfono';
  assert (select data ->> 'createdBy' from public.pengar_records where id = 'de-dani') = r.member_id::text, 'lo que anotó sigue siendo suyo';
  -- Un reintento no duplica
  select * into r from public.pengar_join_household(current_setting('t.newcode'), null, 'llave-de-dani-0123456789abcdefghijklmnop');
  assert r.reclaimed and r.display_name = 'Dani', 'el reintento es lo mismo';
  assert (select count(*) from public.pengar_members) = 3, 'sin duplicar';
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
do $$ begin
  assert (select count(*) from public.pengar_records) = 0, 'el teléfono de antes ya no ve nada';
  assert (select count(*) from public.pengar_households) = 0, 'ni el hogar';
end $$;
-- Ese teléfono de antes se suma de nuevo (sin la llave, o con otra: por ejemplo, para otra persona): es un integrante
-- nuevo, con otro id (el de su usuario ya es el de Dani). Antes chocaba con pengar_members_member_key. Después sale
do $$
declare
  r record;
begin
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Tablet', null);
  assert not r.reclaimed, 'sin la llave, un integrante nuevo';
  assert r.member_id <> '00000000-0000-0000-0000-00000000000d', 'con otro id: el de su usuario es el de Dani';
  assert (select count(*) from public.pengar_members) = 4, 'Ana, Bruno, Dani y la tablet';
  select * into r from public.pengar_join_household(current_setting('t.newcode'), null, 'llave-de-la-tablet-0123456789abcdefghijk');
  assert not r.reclaimed and (select count(*) from public.pengar_members) = 4, 'un reintento con otra llave no duplica';
  assert (select user_id from public.pengar_members where member_id = '00000000-0000-0000-0000-00000000000d') = '00000000-0000-0000-0000-00000000000e',
    'Dani sigue en su teléfono nuevo';
  assert public.pengar_leave_household(current_setting('t.hh')::uuid) = 'left', 'sale';
end $$;

-- Otro teléfono más de Dani entra primero sin la llave (un integrante nuevo) y después con ella: queda uno solo
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
do $$
declare
  r record;
begin
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Dani', null);
  assert not r.reclaimed and (select count(*) from public.pengar_members) = 4, 'sin la llave, otro integrante';
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Dani', 'llave-de-dani-0123456789abcdefghijklmnop');
  assert r.reclaimed and r.member_id = '00000000-0000-0000-0000-00000000000d', 'con la llave, Dani';
  assert (select count(*) from public.pengar_members) = 3, 'el integrante de más se fue';
  -- Una llave nueva (la de antes deja de servir)
  perform public.pengar_set_recovery(current_setting('t.hh')::uuid, 'otra-llave-de-dani-0123456789abcdefghijklm');
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
do $$
declare
  r record;
begin
  begin
    perform public.pengar_set_recovery(current_setting('t.hh')::uuid, 'llave-de-dani-0123456789abcdefghijklmnop');
    raise exception 'quien no es miembro no pone llaves';
  exception when insufficient_privilege then null;
  end;
  select * into r from public.pengar_join_household(current_setting('t.newcode'), 'Dani viejo', 'llave-de-dani-0123456789abcdefghijklmnop');
  assert not r.reclaimed and r.member_id = auth.uid(), 'la llave vieja ya no sirve: es otro integrante';
end $$;

-- Ana saca a los dos teléfonos de Dani (a sí misma no, para eso está salir)
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.pengar_members) = 4, 'Ana, Bruno y los dos de Dani';
  begin
    perform public.pengar_remove_member(current_setting('t.hh')::uuid, auth.uid());
    raise exception 'debería haber fallado';
  exception when invalid_parameter_value then null;
  end;
  perform public.pengar_remove_member(current_setting('t.hh')::uuid, '00000000-0000-0000-0000-00000000000e');
  perform public.pengar_remove_member(current_setting('t.hh')::uuid, '00000000-0000-0000-0000-00000000000f');
  assert (select count(*) from public.pengar_members) = 2, 'Dani ya no está';
  assert (select what from public.pengar_signals where household_id = current_setting('t.hh')::uuid) = 'members', 'aviso de integrantes';
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
do $$ begin
  assert (select count(*) from public.pengar_records) = 0, 'Dani ya no ve nada';
end $$;
-- Dani vuelve con su llave (lo sacaron por error): es el mismo integrante, con su nombre, sin desplazar a nadie
do $$
declare
  r record;
begin
  select * into r from public.pengar_join_household(current_setting('t.newcode'), null, 'otra-llave-de-dani-0123456789abcdefghijklm');
  assert r.reclaimed and r.member_id = '00000000-0000-0000-0000-00000000000d' and r.display_name = 'Dani', 'vuelve como Dani';
  assert (select data ->> 'createdBy' from public.pengar_records where id = 'de-dani') = r.member_id::text, 'lo que anotó sigue siendo suyo';
  assert (select count(*) from public.pengar_members) = 3, 'Ana, Bruno y Dani';
  select * into r from public.pengar_join_household(current_setting('t.newcode'), null, 'otra-llave-de-dani-0123456789abcdefghijklm');
  assert r.reclaimed and r.member_id = '00000000-0000-0000-0000-00000000000d' and (select count(*) from public.pengar_members) = 3, 'un reintento es lo mismo';
  begin
    perform count(*) from public.pengar_departed;
    raise exception 'a los que se fueron no los lee nadie';
  exception when insufficient_privilege then null;
  end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  perform public.pengar_remove_member(current_setting('t.hh')::uuid, '00000000-0000-0000-0000-00000000000f');
  assert (select count(*) from public.pengar_members) = 2, 'Ana lo saca de nuevo';
end $$;

-- Bruno sale: deja de ver el hogar; el hogar sigue con Ana
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert public.pengar_leave_household(current_setting('t.hh')::uuid) = 'left', 'no era el último';
  assert (select count(*) from public.pengar_records) = 0, 'Bruno ya no ve registros';
  assert (select count(*) from storage.objects where bucket_id = 'pengar-files') = 0, 'ni archivos';
end $$;

-- Ana sale (la última): primero el servidor espera que la app borre los archivos (y el código deja de servir);
-- después, el hogar se borra con todo
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert public.pengar_leave_household(current_setting('t.hh')::uuid) = 'last', 'es la última';
  assert (select count(*) from public.pengar_households) = 1, 'el hogar sigue hasta borrar los archivos';
  assert (select invite_code from public.pengar_households) <> current_setting('t.newcode'), 'y nadie más entra con el código';
  assert public.pengar_leave_household(current_setting('t.hh')::uuid, true) = 'deleted', 'era la última';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.pengar_households) = 1, 'queda solo el de Carla';
  assert (select count(*) from public.pengar_members) = 1, 'con Carla';
  assert (select count(*) from public.pengar_records) = 0, 'los registros de Ana se fueron con el hogar';
end $$;

-- Las funciones con privilegios tienen el search_path fijo y no las puede correr anon
do $$
declare
  f record;
begin
  for f in select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'pengar\_%' loop
    assert f.proconfig is not null and 'search_path=public' = any (f.proconfig), f.proname || ' sin search_path fijo';
    assert f.acl not like '%anon=%' and f.acl !~ '(^|[{,])=X/', f.proname || ' la puede correr anon o cualquiera: ' || f.acl;
  end loop;
  assert (select array_agg(proname::text order by proname) from pg_proc where proname like 'pengar\_%' and prosecdef)
    = array['pengar_can_use_file', 'pengar_create_household', 'pengar_is_member', 'pengar_join_household',
            'pengar_leave_household', 'pengar_regenerate_code', 'pengar_remove_member', 'pengar_set_recovery',
            'pengar_signal_household', 'pengar_signal_members', 'pengar_signal_records'], 'security definer solo las que lo necesitan';
  assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pengar_signals'), 'realtime';
  assert not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('pengar_records', 'pengar_members', 'pengar_households')),
    'las tablas de verdad no van a Realtime (sus DELETE no respetan la RLS)';
  assert (select public from storage.buckets where id = 'pengar-files') = false, 'bucket privado';
end $$;

rollback;
