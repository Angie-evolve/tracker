-- ============================================================================
-- 023_roles_de_verdad.sql
--
-- QUE ARREGLA
-- El `022` dejo las piezas (`es_admin`, `puedo_ver_cliente`, `cartera_marcar`)
-- pero nada las usaba: los roles se aplicaban SOLO en el navegador. Esconder
-- no es bloquear —`sbBajar()` se trae todos los clientes completos para
-- cualquiera que este logueado— asi que un CSM tenia los datos de toda la
-- agencia en su navegador aunque la pantalla le mostrara tres.
--
-- Esto conecta las dos mitades: la policy de `clientes` pasa a mirar la
-- cartera, y se agrega la funcion para asignar el rol DESDE LA APP, que es
-- como ella pidio hacerlo (no por SQL).
--
-- ⚠️  ESTA MIGRACION REEMPLAZA UNA POLICY, que es lo unico que el CLAUDE.md
--     pide no hacer sin avisar. No hay alternativa: las policies del mismo
--     comando se combinan con OR, asi que AGREGAR una solo puede ampliar el
--     acceso, nunca recortarlo. Para acotar hay que reemplazar. El texto de
--     la policy vieja esta guardado abajo, en VOLVER ATRAS, palabra por
--     palabra.
--
-- ⚠️  HOY ESTO NO LE CAMBIA NADA A NADIE. Las dos cuentas de agencia son
--     admin (`solo_su_cartera = false`) y para un admin la condicion nueva es
--     `true`. El recorte recien actua cuando alguien quede acotado.
--
-- TODO LO DEMAS ES ADITIVO: dos columnas y dos funciones.
-- ============================================================================

begin;

-- ── La cartera, en la base ──────────────────────────────────────────────────
-- El navegador ya sabia acotar por responsable o por producto. La base solo
-- sabia de responsable, asi que un rol por producto se veia acotado en
-- pantalla y seguia bajandose todo. Estas dos columnas cierran esa diferencia.
alter table public.perfiles
  add column if not exists cartera_modo text not null default 'responsable';

alter table public.perfiles
  add column if not exists cartera_productos text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'perfiles_cartera_modo_ck') then
    alter table public.perfiles
      add constraint perfiles_cartera_modo_ck
      check (cartera_modo in ('responsable','producto'));
  end if;
end $$;

comment on column public.perfiles.cartera_modo is
  'Como se decide que clientes ve quien esta acotado: por responsable o por producto.';
comment on column public.perfiles.cartera_productos is
  'Con cartera_modo = producto, los nombres de producto que ve. Vacio = ninguno.';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- Quien ve que cliente. Reemplaza la version del 022, que solo sabia de
-- responsable. Misma firma, asi que nada de lo que ya la llama se entera.
--
-- ⚠️  `security definer` NO ES DECORATIVO: esta funcion consulta `clientes`, y
--     la policy de `clientes` la va a llamar a ella. Sin definer, cada fila
--     dispararia la policy otra vez y entraria en recursion infinita.
-- ════════════════════════════════════════════════════════════════════════════

-- ⚠️  RECIBE LOS DATOS DE LA FILA, NO SU ID, Y ESO ES LO QUE LA HACE SERVIR
--     PARA `with check`. La primera version buscaba el cliente por id adentro
--     de la funcion; en un UPDATE eso lee la fila COMO ESTABA, no como va a
--     quedar, asi que alguien acotado podia reasignarle su cliente a otra
--     persona y la policy lo dejaba pasar: el `owner` viejo todavia era el
--     suyo. Se detecto probandolo, no leyendolo.
--     Tomando `datos`, Postgres la evalua contra la fila vieja en `using` y
--     contra la nueva en `with check`, que es exactamente lo que hace falta.
--     De paso se ahorra una subconsulta a `clientes` por cada fila.
create or replace function public.cartera_alcanza(p_datos jsonb)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when not public.es_agencia() then false
    when public.es_admin()       then true
    else coalesce((
      select case p.cartera_modo
               -- Un cliente sin responsable no es de nadie: solo lo ven los
               -- admin. Sin el chequeo de vacio, `NULL = mi_mail()` da NULL y
               -- la policy lo trata como falso igual, pero dejarlo explicito
               -- evita que el dia de mañana alguien "simplifique" la linea.
               when 'responsable' then
                 coalesce(p_datos->>'owner','') <> ''
                 and lower(p_datos->>'owner') = public.mi_mail()
               when 'producto' then
                 coalesce(p_datos->>'producto','') <> ''
                 and p_datos->>'producto' = any(p.cartera_productos)
               else false
             end
        from public.perfiles p
       where p.user_id = auth.uid()), false)
  end
$$;

revoke all     on function public.cartera_alcanza(jsonb) from public, anon;
grant  execute on function public.cartera_alcanza(jsonb) to authenticated;

-- La del 022 se conserva porque la app la puede llamar por RPC. Ahora delega,
-- para que no queden dos definiciones de la misma regla separandose sola.
create or replace function public.puedo_ver_cliente(p_cliente text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select public.cartera_alcanza(c.datos)
                     from public.clientes c where c.id::text = p_cliente), false)
$$;

revoke all     on function public.puedo_ver_cliente(text) from public, anon;
grant  execute on function public.puedo_ver_cliente(text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- Asignar el rol desde la app. `perfiles` no tiene grant de escritura para
-- `authenticated` ni policy de escritura —los dos candados del CLAUDE.md— asi
-- que la unica puerta es esta funcion, que es `security definer` y revisa
-- quien llama antes de tocar nada.
--
-- Crea la fila si no existe: una cuenta recien invitada no tiene perfil, y
-- pedirle a alguien que corra un INSERT a mano era justo lo que ella no queria.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.perfil_asignar(
  p_mail       text,
  p_agencia    boolean default true,    -- false = le saca el acceso
  p_acotado    boolean default false,   -- true  = solo ve su cartera
  p_modo       text    default 'responsable',
  p_productos  text[]  default '{}')
returns void language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_mail text; v_admins int;
begin
  if not public.es_admin() then
    raise exception 'Solo un admin puede asignar roles';
  end if;
  if p_modo is null or p_modo not in ('responsable','producto') then
    raise exception 'El modo de cartera tiene que ser responsable o producto';
  end if;

  v_mail := lower(trim(coalesce(p_mail,'')));
  select id into v_id from auth.users where lower(email) = v_mail;
  if v_id is null then
    -- No se crea la cuenta desde aca: eso lo hace la funcion `equipo`, que
    -- ademas manda el mail de invitacion. Inventar el usuario por SQL deja
    -- una cuenta sin confirmar que nadie puede usar.
    raise exception 'Esa cuenta no existe todavia. Invitala primero desde Personas.';
  end if;

  -- ⚠️  NUNCA DEJAR LA CASA SIN LLAVES, igual que `cartera_marcar` del 022 y
  --     que el candado de la pantalla de Roles: si esta es la ultima cuenta
  --     admin, sacarle el acceso o acotarla cierra la app para todos y no hay
  --     forma de volver a abrirla sin meterse por SQL.
  if (not p_agencia or p_acotado) then
    select count(*) into v_admins
      from public.perfiles
     where rol = 'agencia' and not solo_su_cartera and user_id <> v_id;
    if v_admins = 0 then
      raise exception 'Es la ultima cuenta admin: dale acceso a otra antes de sacarle el de esta';
    end if;
  end if;

  insert into public.perfiles (user_id, rol, solo_su_cartera, cartera_modo, cartera_productos)
  values (v_id,
          case when p_agencia then 'agencia' else 'cliente' end,
          coalesce(p_acotado,false), p_modo, coalesce(p_productos,'{}'))
  on conflict (user_id) do update
     set rol               = excluded.rol,
         solo_su_cartera   = excluded.solo_su_cartera,
         cartera_modo      = excluded.cartera_modo,
         cartera_productos = excluded.cartera_productos;
end $$;

revoke all     on function public.perfil_asignar(text, boolean, boolean, text, text[]) from public, anon;
grant  execute on function public.perfil_asignar(text, boolean, boolean, text, text[]) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- LA POLICY. Es el unico cambio que no suma, y es el que hace que el recorte
-- sea real en vez de cosmetico.
--
-- `using` decide que filas se ven (y cuales se pueden tocar en UPDATE/DELETE).
-- `with check` decide como puede quedar la fila despues. Se usa la MISMA
-- condicion en los dos a proposito: asi alguien acotado puede editar sus
-- clientes, pero no puede reasignarle uno a otra persona —la fila resultante
-- tiene que seguir siendo suya— ni robarse uno ajeno.
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists agencia_clientes on public.clientes;

create policy agencia_clientes on public.clientes
  for all
  using      (public.cartera_alcanza(datos))
  with check (public.cartera_alcanza(datos));


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Las columnas nuevas y el check.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='perfiles'
      and column_name in ('cartera_modo','cartera_productos'))            as columnas_nuevas,
  (select count(*) from pg_constraint where conname='perfiles_cartera_modo_ck') as check_puesto;
-- ⚠️  columnas_nuevas = 2, check_puesto = 1

-- b — La policy quedo con la condicion nueva.
select polname, pg_get_expr(polqual, polrelid) as using_expr
  from pg_policy p join pg_class c on c.oid=p.polrelid
 where c.relname='clientes';

-- c — `anon` no puede ejecutar ninguna de las dos funciones.
select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('puedo_ver_cliente','perfil_asignar','cartera_alcanza');
-- ⚠️  anon_puede = false en las dos.

-- d — Sigue habiendo al menos un admin.
select count(*) as admins from public.perfiles
 where rol='agencia' and not solo_su_cartera;
-- ⚠️  tiene que ser >= 1.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- La policy vieja, palabra por palabra, como estaba antes de esta migracion.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop policy if exists agencia_clientes on public.clientes;
  create policy agencia_clientes on public.clientes
    for all
    using      (public.mi_rol() = 'agencia'::text)
    with check (public.mi_rol() = 'agencia'::text);

  drop function if exists public.perfil_asignar(text, boolean, boolean, text, text[]);
  drop function if exists public.cartera_alcanza(jsonb);

  -- `puedo_ver_cliente` vuelve a la version del 022 (solo responsable).
  create or replace function public.puedo_ver_cliente(p_cliente text)
  returns boolean language sql stable security definer set search_path = public
  as $volver$
    select case when not public.es_agencia() then false
                when public.es_admin() then true
           else exists (select 1 from public.clientes c
                 where c.id::text = p_cliente
                   and coalesce(c.datos->>'owner','') <> ''
                   and lower(c.datos->>'owner') = public.mi_mail()) end
  $volver$;

  -- Las columnas se pueden dejar: no molestan y borrarlas no tiene vuelta.
  -- alter table public.perfiles drop column cartera_productos;
  -- alter table public.perfiles drop column cartera_modo;
commit;
*/
-- ============================================================================
