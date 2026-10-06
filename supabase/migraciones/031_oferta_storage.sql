-- 031 · La copia del dataset de oferta, para verlo adentro del tracker
--
-- POR QUE
-- El artifact de claude.ai no sirve para que lo vea el equipo. Dos razones,
-- las dos comprobadas:
--   1. `x-frame-options: SAMEORIGIN`, asi que no se puede embeber.
--   2. Es privado de la cuenta de Angie. El CSM que toca el link ve una
--      pantalla de login y despues "no tenes acceso". Compartir cada artifact
--      a mano desde Share funciona, pero hay que acordarse con cada dataset
--      nuevo, y lo que se olvida no existe.
--
-- Misma salida que la 028 para el reporte de campaña: una copia autocontenida
-- en el bucket privado `material`, y la app la embebe pidiendo una URL firmada
-- en el momento. El bucket es privado a proposito: el dataset lleva precios,
-- margenes y lo que se dijo en las llamadas del cliente.
--
-- La copia tiene que ser AUTOCONTENIDA: la app la mete en `srcdoc`, donde no
-- hay URL base, asi que toda ruta relativa no carga. Imagenes en data URI.

create or replace function public.set_oferta_estado(
  p_id      bigint,
  p_estado  text,
  p_texto   text default null,
  p_url     text default null,
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

  -- La ruta queda acotada a una carpeta y a un .html. Sin esto, el campo
  -- nombra cualquier objeto del bucket y la app lo firma y lo mete en un
  -- iframe: alcanzaria para servir el material privado de otro cliente.
  if p_storage is not null and p_storage !~ '^ofertas/[A-Za-z0-9_-]{1,64}\.html$' then
    raise exception 'oferta: la ruta tiene que ser ofertas/<algo>.html, vino %', p_storage;
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

  update public.clientes
     set maquina = jsonb_set(coalesce(maquina, '{}'::jsonb), '{oferta}', v_val, true)
   where id = p_id;

  if not found then
    raise exception 'oferta: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_oferta_estado(bigint, text, text, text, text) from public;
grant execute on function public.set_oferta_estado(bigint, text, text, text, text) to service_role;

notify pgrst, 'reload schema';

-- OJO: la version de 4 parametros de la 030 sigue existiendo y sigue andando.
-- No se borra: los comandos ya escritos la siguen llamando igual.
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_oferta_estado(bigint, text, text, text, text);
--   y sacar `_ofertaEmbedHtml` de la ficha en la app. Queda la version de la
--   030, que escribe todo menos `storage`.
