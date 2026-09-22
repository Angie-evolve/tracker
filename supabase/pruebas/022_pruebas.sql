-- ============================================================================
-- 022_pruebas.sql   —   NO ES UNA MIGRACION. No va en `migraciones/`.
--
-- Se corre DESPUES del 022. Cada prueba vive adentro de su propia transaccion
-- y termina en `rollback`: no deja ni un dato, ni un cambio.
--
-- Son 5 pruebas. La 1 es la que mas importa: dice que este paso NO le cambio
-- a nadie lo que ve.
--
-- ----------------------------------------------------------------------------
-- ANTES DE EMPEZAR: el editor SQL de Supabase corre como `postgres` y SIN
-- token, asi que `auth.uid()` es NULL, `mi_rol()` da NULL y `es_admin()` da
-- false. Por eso cada prueba que necesita ser alguien arranca haciendose pasar
-- por una cuenta real. El uuid no se escribe a mano en ningun lado: se busca
-- por mail.
--
-- LOS NUMEROS ESPERADOS ESTAN ESCRITOS ABAJO DE CADA PRUEBA, y se escribieron
-- ANTES de correrla. Si alguno no coincide, el que esta mal es el codigo, no
-- el numero: no lo ajustes para que de bien.
-- ----------------------------------------------------------------------------
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 1 — NADIE CAMBIO LO QUE VE
--            Es la razon de ser de este paso. Con la columna en false, las
--            tres cuentas de agencia tienen que seguir viendo TODOS los
--            clientes, los 287 leads y las 171 grabaciones de siempre.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare r record; v_cli int; v_lea int; v_fat int; v_adm boolean; v_mail text;
begin
  for r in select u.id, lower(u.email) as email
             from auth.users u join public.perfiles p on p.user_id = u.id
            where p.rol = 'agencia' order by 2 loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.id, 'role','authenticated', 'email', r.email)::text, true);
    select count(*) into v_cli from public.clientes;
    select count(*) into v_lea from public.leads;
    select count(*) into v_fat from public.llamadas_fathom;
    v_adm  := public.es_admin();
    v_mail := public.mi_mail();
    raise notice '% -> clientes=% leads=% fathom=% es_admin=% mi_mail=%',
      rpad(r.email, 28), v_cli, v_lea, v_fat, v_adm, v_mail;
  end loop;
end $$;

rollback;

-- ⚠️  Tres lineas, TODAS CON EL MISMO NUMERO de clientes, todas con
--     leads=287, fathom=171, es_admin=t, y mi_mail igual al mail de la linea.
--     Si alguna dice es_admin=f, la columna quedo en true en alguien y este
--     paso no era eso.
--
--     Lo que importa es que las tres coincidan entre si, no un numero fijo:
--     la cartera crece. Corrido el 2026-09-22 dio 43 en las tres. El dia
--     antes eran 42, y la diferencia son Baricode y Gymtracko, dos altas
--     reales de ese dia: se comprobo una por una antes de mover el numero.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 2 — `puedo_ver_cliente` reparte bien, SIN que nadie este acotado
--            todavia. Se acota a una cuenta adentro de la transaccion, se
--            mira que devuelve, y se deshace.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare v_uid uuid; v_mail text := 'ashn10291@gmail.com';
        v_suyo text; v_ajeno text; v_sin text;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = v_mail;

  -- Un cliente suyo, uno de otra persona y uno sin dueño.
  select c.id::text into v_suyo  from public.clientes c
   where lower(coalesce(c.datos->>'owner','')) = v_mail limit 1;
  select c.id::text into v_ajeno from public.clientes c
   where coalesce(c.datos->>'owner','') <> ''
     and lower(c.datos->>'owner') <> v_mail limit 1;
  select c.id::text into v_sin   from public.clientes c
   where coalesce(c.datos->>'owner','') = '' limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated', 'email', v_mail)::text, true);

  raise notice 'COMO ADMIN     suyo=% ajeno=% sin_dueno=%',
    public.puedo_ver_cliente(v_suyo), public.puedo_ver_cliente(v_ajeno),
    public.puedo_ver_cliente(v_sin);

  update public.perfiles set solo_su_cartera = true where user_id = v_uid;

  raise notice 'COMO ACOTADO   suyo=% ajeno=% sin_dueno=%',
    public.puedo_ver_cliente(v_suyo), public.puedo_ver_cliente(v_ajeno),
    public.puedo_ver_cliente(v_sin);
end $$;

rollback;

-- ⚠️  COMO ADMIN     suyo=t ajeno=t sin_dueno=t
--     COMO ACOTADO   suyo=t ajeno=f sin_dueno=f
--     El sin_dueño en `f` es la regla "los sin dueño solo los ven los admin".


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 3 — UN NO-ADMIN NO PUEDE USAR LA FUNCION
--            Ni para otro, ni para si mismo, ni para desacotarse.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare v_uid uuid; v_mail text := 'melany@theflowingcode.com'; v_err text;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = v_mail;
  update public.perfiles set solo_su_cartera = true where user_id = v_uid;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated', 'email', v_mail)::text, true);

  begin
    perform public.cartera_marcar('ashn10291@gmail.com', true);
    raise notice 'A OTRO       ❌ LA DEJO PASAR';
  exception when others then
    raise notice 'A OTRO       ✅ %', SQLERRM;
  end;

  begin
    perform public.cartera_marcar(v_mail, false);       -- desacotarse sola
    raise notice 'A SI MISMA   ❌ LA DEJO PASAR';
  exception when others then
    raise notice 'A SI MISMA   ✅ %', SQLERRM;
  end;

  raise notice 'SIGUE ACOTADA: %',
    (select solo_su_cartera from public.perfiles where user_id = v_uid);
end $$;

rollback;

-- ⚠️  Las dos en ✅ con "Solo un admin puede cambiar esto", y SIGUE ACOTADA = t.
--     Que no pueda desacotarse a si misma es el punto: si pudiera, el candado
--     no seria un candado.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 4 — NO SE PUEDE QUITAR EL ULTIMO ADMIN
--            Se acotan dos de las tres cuentas y se intenta acotar la que
--            queda. Tiene que negarse.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare v_yo uuid; v_mail text := 'mdlangierh@gmail.com'; v_quedan int;
begin
  select u.id into v_yo from auth.users u where lower(u.email) = v_mail;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_yo, 'role','authenticated', 'email', v_mail)::text, true);

  raise notice 'ACOTO A LAS OTRAS DOS: % / %',
    public.cartera_marcar('ashn10291@gmail.com', true),
    public.cartera_marcar('melany@theflowingcode.com', true);

  select count(*) into v_quedan from public.perfiles
   where rol='agencia' and not solo_su_cartera;
  raise notice 'ADMINS QUE QUEDAN: %', v_quedan;

  begin
    perform public.cartera_marcar(v_mail, true);        -- el ultimo
    raise notice 'EL ULTIMO    ❌ LA DEJO PASAR';
  exception when others then
    raise notice 'EL ULTIMO    ✅ %', SQLERRM;
  end;

  -- Y desacotar siempre se puede: no hay riesgo en sumar un admin.
  raise notice 'DESACOTAR    ✅ %', public.cartera_marcar('melany@theflowingcode.com', false);
end $$;

rollback;

-- ⚠️  ADMINS QUE QUEDAN = 1, EL ULTIMO en ✅ con "Es el ultimo admin", y
--     DESACOTAR en ✅. Despues del rollback los tres vuelven a admin.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 5 — LA FUNCION SOLO TOCA CUENTAS DE LA AGENCIA
--            Un cliente del portal y un mail que no existe.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare v_yo uuid; v_mail text := 'mdlangierh@gmail.com';
begin
  select u.id into v_yo from auth.users u where lower(u.email) = v_mail;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_yo, 'role','authenticated', 'email', v_mail)::text, true);

  begin
    perform public.cartera_marcar('mdlangierh+albet@gmail.com', true);   -- Fede, del portal
    raise notice 'CLIENTE PORTAL  ❌ LA DEJO PASAR';
  exception when others then
    raise notice 'CLIENTE PORTAL  ✅ %', SQLERRM;
  end;

  begin
    perform public.cartera_marcar('nadie@ejemplo.test', true);
    raise notice 'MAIL INEXISTENTE ❌ LA DEJO PASAR';
  exception when others then
    raise notice 'MAIL INEXISTENTE ✅ %', SQLERRM;
  end;

  -- Y que el mail se compare sin importar mayusculas ni espacios.
  raise notice 'MAIL CON RUIDO  ✅ %',
    public.cartera_marcar('  AshN10291@Gmail.com  ', false);
end $$;

rollback;

-- ⚠️  CLIENTE PORTAL en ✅ con "no es del equipo (rol cliente)".
--     MAIL INEXISTENTE en ✅ con "No hay ninguna cuenta con perfil".
--     MAIL CON RUIDO en ✅: lo encuentra igual.
-- ============================================================================
