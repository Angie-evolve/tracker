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
  -- Todo lo de la 032, tal cual: la version de 6 parametros sigue existiendo
  -- y se llama desde aca para no duplicar las validaciones.
  perform public.set_oferta_estado(p_id, p_estado, p_texto, p_url, p_storage, p_avance);
  if p_estado is null then return; end if;

  if p_url_cliente is not null and p_url_cliente !~ '^https://claude\.ai/artifact/[A-Za-z0-9_-]{6,64}$' then
    raise exception 'oferta: el link de cliente tiene que ser https://claude.ai/artifact/<id>, vino %', p_url_cliente;
  end if;
  if p_storage_cliente is not null and p_storage_cliente !~ '^ofertas/[A-Za-z0-9_-]{1,64}-cliente\.html$' then
    raise exception 'oferta: la ruta de cliente tiene que ser ofertas/<algo>-cliente.html, vino %', p_storage_cliente;
  end if;

  v_val := '{}'::jsonb;
  if p_url_cliente is not null then
    v_val := v_val || jsonb_build_object('urlCliente', p_url_cliente);
  end if;
  if p_storage_cliente is not null then
    v_val := v_val || jsonb_build_object('storageCliente', p_storage_cliente);
  end if;
  if v_val <> '{}'::jsonb then
    update public.clientes
       set maquina = jsonb_set(maquina, '{oferta}', (maquina->'oferta') || v_val, true)
     where id = p_id;
  end if;
end;
$$;

revoke all on function public.set_oferta_estado(bigint, text, text, text, text, int, text, text) from public;
grant execute on function public.set_oferta_estado(bigint, text, text, text, text, int, text, text) to service_role;

notify pgrst, 'reload schema';

-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_oferta_estado(bigint, text, text, text, text, int, text, text);
--   Queda la de 6 parametros (032). Las claves urlCliente/storageCliente que ya
--   esten escritas no molestan a nadie; para limpiarlas,
--   update public.clientes set maquina = jsonb_set(maquina,'{oferta}',(maquina->'oferta') - 'urlCliente' - 'storageCliente');
