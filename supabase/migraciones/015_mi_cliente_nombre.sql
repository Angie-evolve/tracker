-- ============================================================================
-- 015_mi_cliente_nombre.sql
--
-- QUE ARREGLA
-- El portal muestra el mail de la cuenta en el encabezado. Deberia mostrar el
-- nombre de la empresa: quien entra ya sabe cual es su mail, y "Albet" dice
-- mas que "mdlangierh+albet@gmail.com".
--
-- ⚠️  EL PORTAL NO PUEDE LEER ESE NOMBRE. Esta en `clientes.nombre`, y las
--     policies de `clientes` exigen rol agencia. Se midio simulando el perfil
--     `cliente`: la consulta CORRE pero devuelve CERO FILAS. No es un error de
--     permisos que se vea, es una tabla vacia, que es peor: la app no se entera
--     de nada y muestra el fallback para siempre.
--
--     Y NO se arregla agregandole una policy a `clientes`. Esa tabla tiene la
--     columna `datos`, que es el jsonb con TODO: las oportunidades de GHL, las
--     credenciales de las integraciones, las metricas. Dejar entrar a un
--     cliente ahi para que lea un nombre seria abrirle todo lo demas.
--
--     Por eso una funcion `security definer` que devuelve UNA sola columna.
--
-- NO RECIBE PARAMETROS, a proposito. Devuelve el nombre del cliente de QUIEN
-- LLAMA, sacado de su propio perfil. No hay nada que pasarle mal ni nada que
-- probar de a uno: un cliente no puede pedir el nombre de otro porque no hay
-- donde escribirlo.
--
-- TODO ES ADITIVO. Una funcion nueva.
-- ============================================================================

create or replace function public.mi_cliente_nombre()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select c.nombre
    from public.clientes c
   where c.id::text = public.mi_cliente()
$$;

-- `anon` no ejecuta nada. La agencia tampoco la necesita —lee `clientes`
-- directo— pero se le da igual: `mi_cliente()` le devuelve NULL y la funcion
-- devuelve NULL, sin filtrar nada de nadie.
revoke all     on function public.mi_cliente_nombre() from public, anon;
grant  execute on function public.mi_cliente_nombre() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — `anon` no puede.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='mi_cliente_nombre';

-- ⚠️  anon_puede = false.


-- b — Cada cliente recibe SU nombre. Se simula cada perfil y se compara contra
--     lo que dice `clientes`. Tiene que decir ✅ en todos.
do $$
declare r record; v_dice text;
begin
  for r in select p.user_id, p.cliente_id, c.nombre as esperado
             from public.perfiles p
             join public.clientes c on c.id::text = p.cliente_id
            where p.rol = 'cliente'
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.user_id, 'role','authenticated')::text, true);
    v_dice := public.mi_cliente_nombre();
    raise notice '% -> % (esperado %) %',
      r.cliente_id, coalesce(v_dice,'(null)'), r.esperado,
      case when v_dice is not distinct from r.esperado then '✅' else '❌' end;
  end loop;
end $$;


-- c — Que sigan sin poder leer la tabla entera. Esta es la que importa: la
--     funcion no tiene que haber abierto `clientes` por la ventana.
--     (Se corre a mano cambiando de rol; ver el LEEME de pruebas.)


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
drop function if exists public.mi_cliente_nombre();
*/
-- ============================================================================
