-- 032 · Cuanto se avanzo del dataset, para el anillo de la tarjeta
--
-- POR QUE UN NUMERO Y NO DEDUCIRLO DEL TEXTO
-- El icono del dataset en la tarjeta dibuja un anillo que se llena segun el
-- avance. Sacarlo de `texto` pedia que la app supiera cuantas partes tiene el
-- proceso y cuanto pesa cada una. Esas partes viven en el skill `dataset-casa`
-- y ahi se cambian: el dia que cambien, la app estaria mintiendo sin que nadie
-- toque la app. Asi que el numero lo escribe el que arma el dataset, igual que
-- el texto, y la app solo lo dibuja.
--
-- Es 0 a 100. Sin escribir: una oferta `completa` vale 100 y una `curso`
-- dibuja el anillo vacio, que se lee como "hay algo empezado y no se dijo
-- cuanto". Escribirlo es opcional a proposito: no quiero que falte el estado
-- por no saber que porcentaje poner.

create or replace function public.set_oferta_estado(
  p_id      bigint,
  p_estado  text,
  p_texto   text default null,
  p_url     text default null,
  p_storage text default null,
  p_avance  int  default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_val jsonb;
begin
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

  if p_texto is null or length(btrim(p_texto)) = 0 then
    raise exception 'oferta: falta el texto (ej "Parte B · mercado")';
  end if;
  if length(p_texto) > 60 then
    raise exception 'oferta: el texto no puede pasar de 60 caracteres, vinieron %', length(p_texto);
  end if;

  if p_estado = 'completa' and p_url is null then
    raise exception 'oferta: una oferta completa tiene que venir con el link del artifact';
  end if;
  if p_url is not null and p_url !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'oferta: el link tiene que ser https://claude.ai/artifact/<id>, vino %', p_url;
  end if;

  if p_storage is not null and p_storage !~ '^ofertas/[A-Za-z0-9_-]{1,64}\.html$' then
    raise exception 'oferta: la ruta tiene que ser ofertas/<algo>.html, vino %', p_storage;
  end if;

  if p_avance is not null and (p_avance < 0 or p_avance > 100) then
    raise exception 'oferta: el avance va de 0 a 100, vino %', p_avance;
  end if;

  v_val := jsonb_build_object(
    'estado', p_estado,
    'texto',  btrim(p_texto),
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  if p_url is not null then
    v_val := v_val || jsonb_build_object('url', p_url);
  end if;
  if p_storage is not null then
    v_val := v_val || jsonb_build_object('storage', p_storage);
  end if;
  if p_avance is not null then
    v_val := v_val || jsonb_build_object('avance', p_avance);
  end if;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{oferta}', v_val, true)
   where id = p_id;

  if not found then
    raise exception 'oferta: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_oferta_estado(bigint, text, text, text, text, int) from public;
grant execute on function public.set_oferta_estado(bigint, text, text, text, text, int) to service_role;

notify pgrst, 'reload schema';

-- OJO: las versiones de 4 y 5 parametros siguen existiendo y siguen andando.
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_oferta_estado(bigint, text, text, text, text, int);
--   y sacar `ofertaIconoHtml` de la tarjeta en la app. Queda la version de la
--   031, que escribe todo menos `avance`.
