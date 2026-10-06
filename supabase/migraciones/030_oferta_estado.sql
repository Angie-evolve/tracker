-- 030 · En que parte quedo el dataset de oferta de cada cliente
--
-- POR QUE HACE FALTA UN CAMPO NUEVO
-- El tablero no tiene hoy de donde saber en que anda la oferta de un cliente.
-- Lo unico que existe es el documento `gen-oferta` de la ficha, y ese documento
-- NO alcanza: Mi Stock lo tiene cargado y el dataset esta a medias (Creativos,
-- Embudo y Proceso todavia con candado). "Hay documento" no es "esta completa",
-- asi que no se puede deducir: hay que escribirlo.
--
-- Lo escribe el que arma el dataset desde el chat, al cerrar cada parte. La app
-- solo lo muestra.
--
-- POR QUE EN `maquina` Y NO EN `datos`
-- Porque LA APP ES DUEÑA DE `datos` Y LO SUBE ENTERO: cualquier pestaña abierta
-- que no conozca la clave la pisa. Eso ya paso el 05/10 con `reporteCampana`
-- (ver 029). `maquina` + la clave sumada a CLAVES_MAQUINA es el camino que
-- quedo probado.
--
-- LO QUE ESTE CAMPO NO CUMPLE, Y SE ACEPTA SABIENDOLO
-- La regla de `maquina` es "si se pierde, se vuelve a conseguir sola sin que
-- nadie escriba nada". Esta clave NO la cumple: si una pestaña vieja la pisa,
-- no se recupera sola; hay que volver a escribirla desde el chat. Se asume
-- igual porque la alternativa era una tabla aparte con su propia bajada y su
-- propia sincronizacion, que es mucha maquinaria para un renglon de una
-- tarjeta. Si se pierde, se nota: el renglon desaparece de la tarjeta.
--
-- LA FORMA
--   {"estado":"completa"|"curso", "texto":"...", "url":"https://claude.ai/...",
--    "at":"2026-10-06T..."}
-- `texto` lo compone el que escribe, no la app. A proposito: las partes del
-- proceso viven en el skill `dataset-casa` y ahi se cambian solas; si la app
-- las supiera, el dia que cambie el proceso la app miente.

create or replace function public.set_oferta_estado(
  p_id     bigint,
  p_estado text,
  p_texto  text default null,
  p_url    text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_val jsonb;
begin
  -- Pasar estado nulo es la forma de sacar el renglon de la tarjeta cuando un
  -- dataset se abandona. Borra la clave y no toca nada mas.
  if p_estado is null then
    update public.clientes
       set maquina = coalesce(maquina, '{}'::jsonb) - 'oferta'
     where id = p_id;
    if not found then
      raise exception 'oferta: no existe el cliente %', p_id;
    end if;
    return;
  end if;

  if p_estado not in ('completa','curso') then
    raise exception 'oferta: estado tiene que ser completa o curso, vino %', p_estado;
  end if;

  -- El texto se dibuja adentro de la tarjeta, que es UN renglon con puntos
  -- suspensivos. Mas largo que esto no se lee: se corta y no se entera nadie.
  if p_texto is null or length(btrim(p_texto)) = 0 then
    raise exception 'oferta: falta el texto (ej "Parte B · mercado e hipotesis")';
  end if;
  if length(p_texto) > 60 then
    raise exception 'oferta: el texto no puede pasar de 60 caracteres, vinieron %', length(p_texto);
  end if;

  -- Una oferta "completa" sin link no sirve para lo que se pidio, que es poder
  -- abrir el artifact desde la tarjeta. Se exige para que no quede a medias.
  if p_estado = 'completa' and p_url is null then
    raise exception 'oferta: una oferta completa tiene que venir con el link del artifact';
  end if;
  if p_url is not null and p_url !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'oferta: el link tiene que ser https://claude.ai/artifact/<id>, vino %', p_url;
  end if;

  v_val := jsonb_build_object(
    'estado', p_estado,
    'texto',  btrim(p_texto),
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  if p_url is not null then
    v_val := v_val || jsonb_build_object('url', p_url);
  end if;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{oferta}', v_val, true)
   where id = p_id;

  if not found then
    raise exception 'oferta: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_oferta_estado(bigint, text, text, text) from public;
grant execute on function public.set_oferta_estado(bigint, text, text, text) to service_role;

notify pgrst, 'reload schema';

-- OJO: igual que la 029, esto escribe en `maquina`. El `grant update on
-- public.clientes` sigue denegado: la funcion es el unico camino y solo sabe
-- tocar esta clave.
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_oferta_estado(bigint, text, text, text);
--   y sacar 'oferta' de CLAVES_MAQUINA en la app. El campo que ya este escrito
--   queda en `maquina` sin molestar a nadie; para limpiarlo,
--   update public.clientes set maquina = maquina - 'oferta';
