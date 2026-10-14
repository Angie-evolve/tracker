-- 035 · Los cambios detectados en la cuenta, para abrir lineas de conversion
--
-- POR QUE (Angie, 13/10/2026)
-- Cada cambio -prender, apagar o sumar anuncios, presupuesto, publico, la
-- landing, el formulario, las automatizaciones, el pipeline, la calificacion-
-- tiene que abrir una linea de conversion nueva, y los reportes comparan una
-- linea contra la otra. Las lineas se cargaban a mano y los clientes con
-- campana hoy tenian una sola, sin fechas: no habia antes y despues.
--
-- La rutina de la mañana lee el historial de Meta y lo que cambio en GHL y
-- deja aca la lista. Va en `maquina`, como `reporteCampana` y
-- `cambiosPropuestos`: lo escribe una maquina, y si se pierde la corrida
-- siguiente lo reconstruye del historial. Lo que carga una persona -el boton
-- "Registrar cambio" y los cambios de calificacion del tracker- vive en
-- `datos.cambiosManuales`, que sube la app con el resto de la ficha.
--
-- Cada item:
--   id     estable: la rutina lo arma con la fecha y el objeto, asi reescribir
--          la lista no duplica ni pierde nada
--   fecha  ISO, con hora cuando la fuente la da
--   tipo   anuncios | presupuesto | publico | optimizacion | landing |
--          formulario | automatizacion | pipeline | calificacion | otro
--   texto  que cambio, en una frase
--   quien  el nombre que da la fuente, o vacio
--   lado   equipo | cliente | desconocido (GHL no dice quien edito)
--   fuente meta | ghl

create or replace function public.set_cambios_detectados(
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
    raise exception 'cambiosDetectados: p_items tiene que ser un array (puede ser vacio)';
  end if;
  if jsonb_array_length(p_items) > 400 then
    raise exception 'cambiosDetectados: como mucho 400 cambios por cliente, vinieron %', jsonb_array_length(p_items);
  end if;
  for v_it in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'cambiosDetectados: el item % no es un objeto', v_n;
    end if;
    if coalesce(length(v_it->>'id'),0) = 0 or length(v_it->>'id') > 120
       or (v_it->>'id') !~ '^[A-Za-z0-9_:.-]+$' then
      raise exception 'cambiosDetectados: el item % necesita un id corto (letras, numeros, - _ : .)', v_n;
    end if;
    if coalesce(v_it->>'fecha','') !~ '^\d{4}-\d{2}-\d{2}' then
      raise exception 'cambiosDetectados: el item % necesita fecha ISO', v_n;
    end if;
    if coalesce(v_it->>'tipo','') not in ('anuncios','presupuesto','publico','optimizacion','landing',
        'formulario','automatizacion','pipeline','calificacion','otro') then
      raise exception 'cambiosDetectados: el tipo del item % no es valido', v_n;
    end if;
    if coalesce(length(btrim(v_it->>'texto')),0) = 0 or length(v_it->>'texto') > 200 then
      raise exception 'cambiosDetectados: el item % necesita texto (hasta 200 caracteres)', v_n;
    end if;
    if length(coalesce(v_it->>'quien','')) > 80 then
      raise exception 'cambiosDetectados: el quien del item % no puede pasar de 80 caracteres', v_n;
    end if;
    if coalesce(v_it->>'lado','') not in ('equipo','cliente','desconocido') then
      raise exception 'cambiosDetectados: el lado del item % tiene que ser equipo, cliente o desconocido', v_n;
    end if;
    if coalesce(v_it->>'fuente','') not in ('meta','ghl') then
      raise exception 'cambiosDetectados: la fuente del item % tiene que ser meta o ghl', v_n;
    end if;
  end loop;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{cambiosDetectados}',
                     jsonb_build_object(
                       'at',    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'items', p_items),
                     true)
   where id = p_id;

  if not found then
    raise exception 'cambiosDetectados: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_cambios_detectados(bigint, jsonb) from public;
grant execute on function public.set_cambios_detectados(bigint, jsonb) to service_role;

notify pgrst, 'reload schema';

-- COMO SE USA (desde la rutina)
--   ./sbw POST "rpc/set_cambios_detectados" '{"p_id":<id>,"p_items":[
--      {"id":"meta:2026-10-12:ad:120201","fecha":"2026-10-12T22:34:00-03:00",
--       "tipo":"anuncios","texto":"Se prendio el anuncio AD 2.1.2",
--       "quien":"Hanna FH","lado":"equipo","fuente":"meta"}]}'
--   La lista se reescribe entera cada vez: va siempre la ventana completa.
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_cambios_detectados(bigint, jsonb);
--   El campo `maquina.cambiosDetectados` que ya se escribio queda; la app lo
--   ignora si la clave no esta en CLAVES_MAQUINA.
