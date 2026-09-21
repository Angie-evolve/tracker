-- ============================================================================
-- 018_anon_sin_mi_rol.sql
--
-- QUE ARREGLA
-- `mi_rol()` y `mi_cliente()` quedaron ejecutables por `anon`. Salio de correr
-- la PRUEBA 6 completa el 2026-09-20, con la lista de funciones ampliada: son
-- las dos unicas que rompen la regla "anon no ejecuta ninguna".
--
-- NO ES EXPLOTABLE, y conviene decirlo para que nadie se asuste leyendo esto:
-- las dos leen `perfiles` filtrando por `auth.uid()`, que para `anon` es NULL,
-- asi que devuelven NULL. Se comprobo poniendose el rol `anon`:
--     mi_rol()      -> NULL
--     mi_cliente()  -> NULL
--     perfiles      -> permission denied for table perfiles
--
-- SE CIERRA POR LA MISMA RAZON QUE EL 007 cerro `etapa_sin_leads`, que tampoco
-- era explotable: una regla con una excepcion conocida deja de servir para
-- detectar la proxima. Si la prueba 6 dice "anon no puede ninguna" y hay dos
-- que si, la proxima que aparezca se pierde entre el ruido.
--
-- ⚠️  POR QUE ESTE REVOKE ES SEGURO, aunque las dos funciones se usen DENTRO
--     de las policies de `clientes`, `config` y `llamadas_fathom`:
--
--     Una policy se evalua con el rol que consulta. Si `anon` consultara una
--     de esas tablas sin permiso de ejecutar `mi_rol()`, la consulta moriria
--     con "permission denied for function" en vez de devolver cero filas.
--
--     No pasa, porque `anon` NO LLEGA AHI: se frena antes, en el grant de la
--     tabla. Medido el 2026-09-20 poniendose el rol `anon`, las seis tablas
--     contestan "permission denied for table", no "cero filas". El grant se
--     chequea ANTES que la RLS, asi que la policy nunca se evalua y la
--     funcion nunca se llama.
--
--     Si algun dia se le diera SELECT a `anon` sobre alguna de esas tablas,
--     ESTE REVOKE HAY QUE REVISARLO PRIMERO.
--
-- TODO ES REVERSIBLE. Dos revokes.
-- ============================================================================

revoke all on function public.mi_rol()     from public, anon;
revoke all on function public.mi_cliente() from public, anon;

-- `authenticated` las sigue necesitando: son la base de `es_agencia()` y de
-- los guardas de todas las funciones `lead_*` y `etapa_*`.
grant execute on function public.mi_rol()     to authenticated;
grant execute on function public.mi_cliente() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Ninguna funcion de `public` la puede ejecutar `anon`. CERO FILAS.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and has_function_privilege('anon', p.oid, 'execute')
 order by p.proname;

-- ⚠️  Cero filas. Esta consulta mira TODAS las funciones de `public`, no una
--     lista escrita a mano: si mañana aparece otra abierta, esta la encuentra.


-- b — Que el tracker y el portal sigan andando: `authenticated` las conserva.
select has_function_privilege('authenticated', 'public.mi_rol()',     'execute') as logueado_mi_rol,
       has_function_privilege('authenticated', 'public.mi_cliente()', 'execute') as logueado_mi_cliente,
       public.es_agencia() is not null                                           as es_agencia_contesta;


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
grant execute on function public.mi_rol()     to anon;
grant execute on function public.mi_cliente() to anon;
*/
-- ============================================================================
