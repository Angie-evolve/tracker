-- 027 · El reporte de campañas se guarda solo en la ficha del cliente
--
-- QUE RESUELVE
-- La tarea `reporte-campanas-diario` arma el reporte de cada cliente y lo
-- publica como artifact. Para que ese link aparezca en la app hay que
-- guardarlo en el cliente, y hasta ahora la tarea no podia: es de solo
-- lectura, y el rol no tiene UPDATE sobre `clientes`.
--
--   ./sbw PATCH "clientes?id=eq.1" '{"datos":{}}'
--   HTTP 403 · 42501 · permission denied for table clientes
--
-- ESE 403 NO SE SACA DEL MEDIO
-- Negarle UPDATE sobre `clientes` esta puesto a proposito: `datos` lleva
-- adentro `metaToken` y `ghl.token`, y un UPDATE sobre la tabla entera deja
-- pisarlos -o leerlos escribiendo encima y mirando la fila que vuelve-. Un
-- `grant update on public.clientes` arregla este caso y abre todos los demas.
--
-- Entonces no se da el permiso: se da UNA FUNCION que solo sabe escribir una
-- clave. Es `security definer`, asi que corre con los permisos del dueño de la
-- tabla, pero lo unico que puede hacer es poner `datos.reporteCampana`. No
-- puede tocar otra clave, ni otra tabla, ni leer la fila.

create or replace function public.set_reporte_campana(
  p_id  bigint,
  p_url text
)
returns void
language plpgsql
security definer
-- Sin esto, quien llame puede anteponer un esquema propio y hacer que
-- `jsonb_set` resuelva a otra funcion. Con `security definer` eso corre como
-- el dueño de la tabla.
set search_path = public, pg_temp
as $$
begin
  -- El link tiene que ser un artifact de claude.ai y nada mas. Sin esto, la
  -- funcion es un campo de texto libre que despues la app abre en una pestaña:
  -- cualquier cosa que entre ahi termina siendo un link en el que se hace clic.
  if p_url !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'reporteCampana: el link tiene que ser https://claude.ai/artifact/<id>, vino %', p_url;
  end if;

  update public.clientes
     set datos = jsonb_set(
           coalesce(datos, '{}'::jsonb),
           '{reporteCampana}',
           jsonb_build_object('url', p_url, 'at', to_char(now() at time zone 'utc',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           true)
   where id = p_id;

  if not found then
    raise exception 'reporteCampana: no existe el cliente %', p_id;
  end if;
end;
$$;

-- `service_role` es la clave de la tarea y de las funciones; nunca sale al
-- navegador. `anon` y `authenticated` NO la reciben: desde la app y desde el
-- portal esta funcion no existe.
revoke all on function public.set_reporte_campana(bigint, text) from public;
grant execute on function public.set_reporte_campana(bigint, text) to service_role;

-- PostgREST cachea el esquema: sin esto la funcion no aparece en /rpc hasta
-- que recicle solo.
notify pgrst, 'reload schema';

-- COMO SE USA
--   ./sbw POST "rpc/set_reporte_campana" \
--     '{"p_id":1780612432151,"p_url":"https://claude.ai/artifact/XXXXXXXX"}'
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_reporte_campana(bigint, text);
--   notify pgrst, 'reload schema';
-- Eso deja la tarea sin forma de guardar el link; la app deja de mostrar el
-- boton del reporte y los `datos.reporteCampana` que ya se escribieron quedan
-- donde estan, porque son solo un dato mas adentro de `datos`.
