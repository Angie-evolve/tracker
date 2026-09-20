-- ============================================================================
-- 003_service_role_perfiles.sql
--
-- POR QUÉ SE AGREGA: lo necesita la edge function `invitar-portal`, que crea
-- la cuenta de un cliente del portal. Esa función entra con la service key y
-- hace tres cosas que sin estos grants fallan:
--
--   1. lee `perfiles` para confirmar que quien llama es 'agencia'  (SELECT)
--   2. lee `clientes` para validar el cliente_id del pedido        (SELECT)
--   3. escribe el perfil del cliente recién creado                 (INSERT/UPDATE)
--
-- Sin el punto 1 la función devuelve 403 a todo el mundo, incluida la agencia,
-- y las pruebas de permisos dan el codigo esperado por el motivo equivocado:
-- parece que el control de acceso anda cuando en realidad no llego a correr.
--
-- `service_role` tiene BYPASSRLS, asi que las policies no la frenan. Lo que la
-- frenaba eran los grants, que nunca se le habian dado.
--
-- SIN DELETE, a proposito: `invitar-portal` no borra nada. Dar de baja a un
-- cliente del portal es otra tarea y va a necesitar su propia decision.
-- ============================================================================

grant select, insert, update on public.perfiles to service_role;
grant select on public.clientes to service_role;


-- ── Vuelta atrás ────────────────────────────────────────────────────────────
-- Deja a service_role como estaba: sin acceso a los datos de ninguna de las
-- dos. Rompe `invitar-portal`, que es justamente lo que se quiere si hay que
-- cortar esa funcion de apuro.
/*
revoke select, insert, update on public.perfiles from service_role;
revoke select on public.clientes from service_role;
*/
