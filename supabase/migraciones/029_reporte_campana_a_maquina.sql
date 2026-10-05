-- 029 · El reporte de campaña se guarda en `maquina`, no en `datos`
--
-- QUE PASO
-- La 027 y la 028 escribian `datos.reporteCampana`. Se probo el 05/10 con
-- Ojapo: la funcion escribio bien, se verifico en la base, y trece minutos
-- despues el campo ya no estaba.
--
-- No lo borro nadie. LA APP ES DUEÑA DE `datos` Y LO SUBE ENTERO. Cuando
-- cualquier cosa de ese cliente cambia en el navegador, `sbSubir` manda el
-- `datos` que tiene en memoria -que nunca vio `reporteCampana`- y lo pisa. El
-- `datos_at` de las 18:23 es esa subida.
--
-- Para eso existe la columna `maquina`, que la 025 separo justamente para lo
-- que escriben las maquinas y no las personas. Su regla, escrita al lado de
-- `CLAVES_MAQUINA` en la app:
--
--     "si se pierde, se vuelve a conseguir sola sin que nadie escriba nada"
--
-- `reporteCampana` la cumple: si se pierde, la tarea de la mañana lo vuelve a
-- escribir. Y con la clave sumada a `CLAVES_MAQUINA`, la app la lee al bajar y
-- la devuelve al subir, asi que deja de pisarla.
--
-- QUEDA UNA CARRERA CHICA, Y SE ACEPTA A PROPOSITO: entre que la tarea escribe
-- y el navegador vuelve a bajar, una subida de `maquina` desde una pestaña
-- vieja puede pisar el campo. Se recupera solo a la mañana siguiente. Cerrarla
-- del todo pedia una tabla aparte, que es mas maquinaria de la que vale un
-- link que se reescribe todos los dias.

drop function if exists public.set_reporte_campana(bigint, text, text);
drop function if exists public.set_reporte_campana(bigint, text);

create or replace function public.set_reporte_campana(
  p_id      bigint,
  p_url     text,
  p_storage text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_val jsonb;
begin
  if p_url !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'reporteCampana: el link tiene que ser https://claude.ai/artifact/<id>, vino %', p_url;
  end if;

  -- La ruta queda acotada a una carpeta y a un .html. Sin esto, el campo
  -- nombra cualquier objeto del bucket y la app lo firma y lo mete en un
  -- iframe: alcanzaria para servir el material privado de otro cliente.
  if p_storage is not null and p_storage !~ '^reportes/[A-Za-z0-9_-]{1,64}\.html$' then
    raise exception 'reporteCampana: la ruta tiene que ser reportes/<algo>.html, vino %', p_storage;
  end if;

  v_val := jsonb_build_object(
    'url', p_url,
    'at',  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  if p_storage is not null then
    v_val := v_val || jsonb_build_object('storage', p_storage);
  end if;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{reporteCampana}', v_val, true),
         -- Y se saca el que haya quedado en `datos` de las versiones
         -- anteriores, para que no queden dos y gane el equivocado.
         datos   = coalesce(datos, '{}'::jsonb) - 'reporteCampana'
   where id = p_id;

  if not found then
    raise exception 'reporteCampana: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_reporte_campana(bigint, text, text) from public;
grant execute on function public.set_reporte_campana(bigint, text, text) to service_role;

notify pgrst, 'reload schema';

-- OJO: esto escribe en `maquina`, que hasta ahora solo escribia la app. El
-- `grant update on public.clientes` sigue denegado: la funcion es el unico
-- camino, y solo sabe tocar esta clave.
--
-- COMO SE VUELVE ATRAS
--   volver a correr 028_reporte_campana_storage.sql, que deja la version que
--   escribe en `datos`, y sacar 'reporteCampana' de CLAVES_MAQUINA en la app.
--   Vuelve el pisado del 05/10.
