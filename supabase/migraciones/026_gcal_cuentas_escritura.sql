-- 026 · gcal_cuentas: que el servidor pueda escribir
--
-- QUE PASABA
-- Conectar una cuenta de Google terminaba en "Se conecto pero no pude
-- guardarlo". El permiso de Google estaba bien y la Edge Function recibia el
-- refresh token; lo que fallaba era el INSERT, con 42501:
--   permission denied for table gcal_cuentas
--
-- POR QUE
-- La tabla quedo cerrada de mas: a `service_role` le faltaban SELECT, INSERT y
-- UPDATE. Los tres, no dos. Parecia que leer funcionaba porque la funcion se
-- tragaba el 403 del SELECT y devolvia la lista de cuentas vacia, que es
-- indistinguible de "todavia no hay ninguna conectada". El upsert necesita
-- SELECT ademas de INSERT: para resolver el conflicto tiene que poder mirar si
-- la fila ya existe.
--
-- ESTO NO AFLOJA EL CANDADO
-- La tabla guarda credenciales y sigue con RLS prendida y CERO policies, a
-- proposito. `anon` y `authenticated` siguen sin poder tocarla: desde la app y
-- desde el portal es inalcanzable, y asi tiene que seguir.
-- `service_role` es la clave que vive solo en los secretos de la funcion y
-- nunca sale al navegador. Es el unico escritor legitimo que tiene esta tabla,
-- y hasta ahora no podia escribir.

grant select, insert, update on public.gcal_cuentas to service_role;

-- PostgREST cachea los permisos: sin esto el grant no se ve hasta que recicle.
notify pgrst, 'reload schema';

-- COMO SE VUELVE ATRAS
--   revoke select, insert, update on public.gcal_cuentas from service_role;
--   notify pgrst, 'reload schema';
-- Eso deja la tabla como estaba: conectar una cuenta vuelve a fallar con 42501,
-- y la lista de cuentas conectadas vuelve a salir vacia sin decir por que.
