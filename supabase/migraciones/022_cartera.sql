-- ============================================================================
-- 022_cartera.sql   —   PASO 0 de "cada CSM ve solo su cartera"
--
-- ⚠️  ESTE ARCHIVO NO CAMBIA LO QUE VE NADIE. Ni una policy se toca. La
--     columna nace en `false` para todo el mundo y en `false` todos son
--     admin, asi que las tres cuentas de agencia siguen viendo los 42
--     clientes igual que ayer. Es la cañeria, no la llave.
--
-- QUE DEJA LISTO
--   1. `perfiles.solo_su_cartera`, la marca de "esta acotado a sus clientes".
--   2. `mi_mail()`, `es_admin()` y `puedo_ver_cliente(text)`, que son las tres
--      piezas con las que el Paso 1 va a escribir las policies.
--   3. `cartera_marcar(text, boolean)`, para prender y apagar esa marca DESDE
--      LA APP, con los tres candados de siempre.
--   4. `equipo_roles()`, para que la pantalla pueda dibujar como esta cada uno.
--
-- ⚠️  POR QUE UNA COLUMNA Y NO UN ROL 'csm' NUEVO. `es_agencia()` es
--     `mi_rol() = 'agencia'`, y de eso cuelgan las policies de `etapas`,
--     `leads`, `config`, `llamadas_fathom`, `ia_jobs` y `lp_eventos`, mas los
--     guardas de todas las funciones `lead_*` y `etapa_*`. Un rol nuevo deja
--     al CSM afuera de TODO eso de un saque, y para volver a dejarlo entrar
--     hay que reescribir doce policies: doce oportunidades de encerrar a
--     alguien fuera de su propia herramienta. Con una columna aparte el CSM
--     sigue siendo `agencia` y solo se toca lo que hay que acotar.
--
-- TODO ES ADITIVO. Una columna con default, y cuatro funciones nuevas.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — la columna
-- ════════════════════════════════════════════════════════════════════════════

alter table public.perfiles
  add column if not exists solo_su_cartera boolean not null default false;

comment on column public.perfiles.solo_su_cartera is
  'false = admin: ve todos los clientes. true = acotado: solo ve aquellos '
  'donde su mail figura como responsable (clientes.datos->>''owner''). '
  'Solo aplica a rol = agencia; en una cuenta de portal no significa nada.';


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — las tres piezas para las policies del Paso 1
-- ════════════════════════════════════════════════════════════════════════════

-- ⚠️  EL MAIL SE LEE DE `auth.users`, NO DEL JWT. `auth.jwt()->>'email'` es lo
--     que habia adentro del token cuando se emitio: si alguien cambia su mail,
--     el token viejo sigue diciendo el anterior hasta que se renueve, y en ese
--     rato la persona ve la cartera equivocada. `auth.users` es la fuente.
create or replace function public.mi_mail()
returns text language sql stable security definer set search_path = public
as $$ select lower(u.email) from auth.users u where u.id = auth.uid() $$;

-- Nunca devuelve NULL, igual que `es_agencia()`: un `if` con NULL no entra, y
-- ese es exactamente el tipo de agujero que no se nota hasta que alguien ve
-- lo que no tenia que ver.
create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p.rol = 'agencia' and not p.solo_su_cartera
       from public.perfiles p where p.user_id = auth.uid()),
    false)
$$;

-- ⚠️  "SIN DUEÑO" ES SOLO DE LOS ADMIN, y esta escrito a proposito con un
--     `<> ''` en vez de dejarlo salir de que NULL no matchea con nada. La
--     version corta —`lower(owner) = mi_mail()`— tambien deja afuera a los sin
--     dueño, pero por un efecto colateral: el dia que `mi_mail()` devolviera
--     cadena vacia en vez de NULL, los 20 clientes sin responsable se le
--     abririan a cualquiera. Preferimos que la regla diga lo que quiere decir.
create or replace function public.puedo_ver_cliente(p_cliente text)
returns boolean language sql stable security definer set search_path = public
as $$
  select case
    when not public.es_agencia() then false
    when public.es_admin()       then true
    else exists (
      select 1 from public.clientes c
       where c.id::text = p_cliente
         and coalesce(c.datos->>'owner','') <> ''
         and lower(c.datos->>'owner') = public.mi_mail())
  end
$$;

revoke all     on function public.mi_mail()                from public, anon;
revoke all     on function public.es_admin()               from public, anon;
revoke all     on function public.puedo_ver_cliente(text)  from public, anon;
grant  execute on function public.mi_mail()                to authenticated;
grant  execute on function public.es_admin()               to authenticated;
grant  execute on function public.puedo_ver_cliente(text)  to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — marcar y desmarcar, desde la app
--
-- `perfiles` no tiene grant de escritura para `authenticated` y no lo va a
-- tener: es el candado que impide que alguien se ascienda a agencia desde la
-- consola del navegador. Por eso esto es `security definer`, que escribe por
-- su cuenta, y por eso los tres candados van ADENTRO de la funcion.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.cartera_marcar(
  p_email text,
  p_solo  boolean)
returns text language plpgsql security definer set search_path = public
as $$
declare v_uid uuid; v_rol text; v_era boolean; v_admins int;
begin
  -- CANDADO 1 — solo un admin. Un acotado no puede cambiar el rol de nadie,
  -- ni el propio: `es_admin()` ya es false para el.
  if not public.es_admin() then
    raise exception 'Solo un admin puede cambiar esto';
  end if;

  select u.id, p.rol, p.solo_su_cartera
    into v_uid, v_rol, v_era
    from auth.users u
    join public.perfiles p on p.user_id = u.id
   where lower(u.email) = lower(btrim(coalesce(p_email,'')));

  if v_uid is null then
    raise exception 'No hay ninguna cuenta con perfil para %', coalesce(p_email,'(vacio)');
  end if;

  -- CANDADO 2 — solo cuentas del equipo. Un cliente del portal ya esta
  -- acotado por `mi_cliente()`, y esta marca ahi no significa nada: dejarla
  -- puesta seria dar a entender que hace algo cuando no hace nada.
  if v_rol is distinct from 'agencia' then
    raise exception 'Esa cuenta no es del equipo (rol %). Esto es solo para la agencia',
      coalesce(v_rol,'ninguno');
  end if;

  -- CANDADO 3 — nunca dejar el sistema sin admin. El ultimo que queda es el
  -- unico que puede volver atras cualquiera de estas marcas: si se acota,
  -- no queda nadie que pueda desacotarlo y hay que entrar por SQL.
  if p_solo and not v_era then
    select count(*) into v_admins
      from public.perfiles
     where rol = 'agencia' and not solo_su_cartera;
    if v_admins <= 1 then
      raise exception 'Es el ultimo admin: acotandolo no queda nadie que pueda volver atras';
    end if;
  end if;

  update public.perfiles
     set solo_su_cartera = coalesce(p_solo, false)
   where user_id = v_uid;

  return case when coalesce(p_solo,false)
    then 'Ahora ve solo los clientes donde figura como responsable'
    else 'Ahora ve todos los clientes' end;
end $$;

revoke all     on function public.cartera_marcar(text, boolean) from public, anon;
grant  execute on function public.cartera_marcar(text, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — leer como esta cada uno
--
-- ⚠️  ESTO NO ESTABA EN EL PEDIDO y lo agrego igual, porque sin esto la
--     pantalla no puede dibujar el interruptor: `perfiles` tiene una sola
--     policy de lectura, `user_id = auth.uid()`, asi que ni un admin puede
--     ver el perfil de otro. Marcar sin poder ver como quedo es la mitad de
--     la funcionalidad. Es de solo lectura y solo para admin; si preferis que
--     no exista, se borra sola con el `drop` del final.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.equipo_roles()
returns table(email text, rol text, solo_su_cartera boolean, nombre text)
language sql stable security definer set search_path = public
as $$
  select lower(u.email), p.rol, p.solo_su_cartera, p.nombre
    from public.perfiles p
    join auth.users u on u.id = p.user_id
   where public.es_admin()          -- sin esto devuelve cero filas, no un error
     and p.rol = 'agencia'
   order by lower(u.email)
$$;

revoke all     on function public.equipo_roles() from public, anon;
grant  execute on function public.equipo_roles() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
--
-- Las pruebas de verdad viven en `supabase/pruebas/022_pruebas.sql`, que se
-- pone en la piel de cada cuenta. Esto de aca es el vistazo rapido.
-- ════════════════════════════════════════════════════════════════════════════

-- a — La columna existe y esta en false para los cinco perfiles.
select rol, count(*) as cuentas,
       count(*) filter (where solo_su_cartera) as acotadas
  from public.perfiles group by 1 order by 1;

-- ⚠️  acotadas = 0 en las dos filas. Nadie quedo marcado.


-- b — Las cuatro funciones existen y `anon` no puede ninguna.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('mi_mail','es_admin','puedo_ver_cliente',
                     'cartera_marcar','equipo_roles')
 order by 1;

-- ⚠️  Las cinco filas con security_definer = true, anon_puede = false y
--     logueado_puede = true. (Son cinco porque `puedo_ver_cliente` cuenta una.)


-- c — Ninguna policy se movio. Siguen siendo las mismas de antes.
select count(*) as policies_en_public from pg_policies where schemaname='public';

-- ⚠️  El mismo numero que antes de correr esto: 26. Contado el 2026-09-22,
--     antes de tocar nada.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- La columna se puede dejar: en `false` no hace nada y nadie la lee todavia.
-- Igual va el `drop` completo, por si hay que borrar de verdad.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop function if exists public.equipo_roles();
  drop function if exists public.cartera_marcar(text, boolean);
  drop function if exists public.puedo_ver_cliente(text);
  drop function if exists public.es_admin();
  drop function if exists public.mi_mail();
  alter table public.perfiles drop column if exists solo_su_cartera;
commit;
*/
-- ============================================================================
