-- 038 · Hasta 60 cambios propuestos por cliente (antes 20)
--
-- POR QUE (Angie, 14/10/2026)
-- En la misma lista conviven los cambios de la rutina de campañas y los
-- pendientes de las llamadas (id "llamada-..."). Desde el 14/10 tambien se
-- cargan los de las llamadas internas, de equipo y de ventas, en la ficha
-- "Evolve (interno)", y con una semana de llamadas 20 no alcanzaba: los nuevos
-- quedaban afuera. Es la misma funcion de la 034 con el tope en 60.

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
  if jsonb_array_length(p_items) > 60 then
    raise exception 'cambiosPropuestos: como mucho 60 cambios por cliente, vinieron %', jsonb_array_length(p_items);
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

-- COMO SE VUELVE ATRAS
--   Volver a correr supabase/migraciones/034_cambios_propuestos.sql (tope 20).
--   Las listas que ya tengan mas de 20 items quedan como estan; la proxima
--   escritura con mas de 20 va a ser rechazada.
