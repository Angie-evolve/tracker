-- 034 · Los cambios que propone la rutina de campañas, como lista para decidir
--
-- POR QUE (Angie, 08/10/2026)
-- La rutina de la mañana deja el reporte por cliente como HTML. Lo que
-- recomienda ("pausar el conjunto X", "subir presupuesto del anuncio Y") queda
-- adentro del texto y nadie lo decide: ni se hace ni se descarta. El Dashboard
-- ya lista los cambios de las revisiones con "Crear ticket / Descartar"; esto
-- le da a la rutina el mismo lugar.
--
-- Va en `maquina`, como `reporteCampana`: lo escribe una maquina y, si se
-- pierde, la corrida del dia siguiente lo vuelve a escribir. Las DECISIONES
-- (ticket creado, descartado) no van aca: las escribe una persona y viven en
-- `datos.cambiosDecisiones`, que la app sube con el resto de la ficha.
--
-- Cada item lleva un `id` estable (la rutina lo arma con fecha + texto) para
-- que la decision de hoy siga valiendo cuando la rutina reescriba la lista
-- manana con el mismo cambio.

create or replace function public.set_cambios_propuestos(
  p_id    bigint,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_it jsonb;
  v_n  int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'cambiosPropuestos: p_items tiene que ser un array (puede ser vacio)';
  end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception 'cambiosPropuestos: como mucho 20 cambios por cliente, vinieron %', jsonb_array_length(p_items);
  end if;
  for v_it in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'cambiosPropuestos: el item % no es un objeto', v_n;
    end if;
    if coalesce(length(v_it->>'id'),0) = 0 or length(v_it->>'id') > 80
       or (v_it->>'id') !~ '^[A-Za-z0-9_-]+$' then
      raise exception 'cambiosPropuestos: el item % necesita un id corto (letras, numeros, - y _)', v_n;
    end if;
    if coalesce(length(btrim(v_it->>'texto')),0) = 0 or length(v_it->>'texto') > 200 then
      raise exception 'cambiosPropuestos: el item % necesita texto (hasta 200 caracteres)', v_n;
    end if;
    if length(coalesce(v_it->>'porque','')) > 400 then
      raise exception 'cambiosPropuestos: el porque del item % no puede pasar de 400 caracteres', v_n;
    end if;
  end loop;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{cambiosPropuestos}',
                     jsonb_build_object(
                       'at',    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'items', p_items),
                     true)
   where id = p_id;

  if not found then
    raise exception 'cambiosPropuestos: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_cambios_propuestos(bigint, jsonb) from public;
grant execute on function public.set_cambios_propuestos(bigint, jsonb) to service_role;

notify pgrst, 'reload schema';

-- COMO SE USA (desde la rutina)
--   ./sbw POST "rpc/set_cambios_propuestos" \
--     '{"p_id":1787864598022,"p_items":[
--        {"id":"2026-10-12-pausar-cjto-remarketing","texto":"Pausar el conjunto Remarketing",
--         "porque":"USD 38 en 3 dias sin un registro; el resto de la cuenta esta en USD 6 por registro"}]}'
--   Con `p_items: []` se deja la lista vacia (no hay nada que proponer hoy).
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_cambios_propuestos(bigint, jsonb);
--   El campo `maquina.cambiosPropuestos` que ya se escribio queda; la app lo
--   ignora si la clave no esta en CLAVES_MAQUINA.
