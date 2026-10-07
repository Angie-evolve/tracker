-- 033 · El link de la vista CLIENTE del dataset
--
-- POR QUE DOS LINKS (Angie, 07/10/2026)
-- El dataset tiene dos vistas generadas de la misma fuente: la de equipo, con
-- todo (Value Equation, HIDE, fugazi, los "a validar", las fuentes, los
-- prompts), y la de cliente, con eso sacado de verdad del archivo. No es un
-- boton que esconde: lo que el cliente no tiene que ver no viaja en lo que se
-- le manda. Por eso son dos artifacts y dos copias, y la ficha guarda los dos.
--
-- `url` y `storage` siguen siendo la vista de equipo (la que abre el birrete
-- de la tarjeta). `url_cliente` y `storage_cliente` son la vista de cliente:
-- la que se comparte y la que va a leer el portal.

-- Las versiones de 4, 5 y 6 parametros se borran: con defaults, convivir con
-- esta hacia que CUALQUIER llamada fuera ambigua (42725). Esta cubre a todas.
drop function if exists public.set_oferta_estado(bigint, text, text, text);
drop function if exists public.set_oferta_estado(bigint, text, text, text, text);
drop function if exists public.set_oferta_estado(bigint, text, text, text, text, int);

create or replace function public.set_oferta_estado(
  p_id              bigint,
  p_estado          text,
  p_texto           text default null,
  p_url             text default null,
  p_storage         text default null,
  p_avance          int  default null,
  p_url_cliente     text default null,
  p_storage_cliente text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_val jsonb;
begin
  -- OJO: no se llama a la version de 6 parametros desde aca. Con los defaults,
  -- Postgres no sabe cual elegir (42725, "is not unique") y la llamada falla.
  -- Se repite la logica de la 032 y se suma lo de cliente.
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
  if p_url_cliente is not null and p_url_cliente !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'oferta: el link de cliente tiene que ser https://claude.ai/artifact/<id>, vino %', p_url_cliente;
  end if;
  if p_storage_cliente is not null and p_storage_cliente !~ '^ofertas/[A-Za-z0-9_-]{1,64}-cliente\.html$' then
    raise exception 'oferta: la ruta de cliente tiene que ser ofertas/<algo>-cliente.html, vino %', p_storage_cliente;
  end if;

  v_val := jsonb_build_object(
    'estado', p_estado,
    'texto',  btrim(p_texto),
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  if p_url is not null then v_val := v_val || jsonb_build_object('url', p_url); end if;
  if p_storage is not null then v_val := v_val || jsonb_build_object('storage', p_storage); end if;
  if p_avance is not null then v_val := v_val || jsonb_build_object('avance', p_avance); end if;
  if p_url_cliente is not null then v_val := v_val || jsonb_build_object('urlCliente', p_url_cliente); end if;
  if p_storage_cliente is not null then v_val := v_val || jsonb_build_object('storageCliente', p_storage_cliente); end if;

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{oferta}', v_val, true)
   where id = p_id;
  if not found then
    raise exception 'oferta: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_oferta_estado(bigint, text, text, text, text, int, text, text) from public;
grant execute on function public.set_oferta_estado(bigint, text, text, text, text, int, text, text) to service_role;

notify pgrst, 'reload schema';

-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_oferta_estado(bigint, text, text, text, text, int, text, text);
--   y volver a correr la 032 para recuperar la de 6 parametros. Las claves urlCliente/storageCliente que ya
--   esten escritas no molestan a nadie; para limpiarlas,
--   update public.clientes set maquina = jsonb_set(maquina,'{oferta}',(maquina->'oferta') - 'urlCliente' - 'storageCliente');
