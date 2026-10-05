-- 028 · El reporte tambien guarda donde quedo la copia para embeber
--
-- QUE RESUELVE
-- La 027 dejo a la tarea guardar el link del artifact. Pero el artifact NO se
-- puede embeber: claude.ai contesta con `x-frame-options: SAMEORIGIN` y el
-- navegador bloquea el iframe desde el tracker.
--
-- Entonces la tarea sube ademas una copia del HTML al bucket privado
-- `material` y la app embebe ESA, con una URL firmada que pide en el momento.
-- Para eso hace falta guardar la ruta, y la funcion de la 027 solo sabia
-- escribir `url`: cada corrida la pisaba y se perdia.
--
-- La firma no cambia de idea: sigue siendo lo unico que la tarea puede
-- escribir, y sigue sin poder tocar otra clave ni otra tabla. `p_storage` es
-- opcional, asi que una llamada vieja de dos argumentos sigue andando.

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
  -- iframe: alcanzaria para que una corrida equivocada sirva el material
  -- privado de otro cliente.
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
     set datos = jsonb_set(coalesce(datos, '{}'::jsonb), '{reporteCampana}', v_val, true)
   where id = p_id;

  if not found then
    raise exception 'reporteCampana: no existe el cliente %', p_id;
  end if;
end;
$$;

revoke all on function public.set_reporte_campana(bigint, text, text) from public;
grant execute on function public.set_reporte_campana(bigint, text, text) to service_role;

notify pgrst, 'reload schema';

-- COMO SE USA
--   ./sbw POST "rpc/set_reporte_campana" \
--     '{"p_id":1780612432151,"p_url":"https://claude.ai/artifact/XXXX",
--       "p_storage":"reportes/1780612432151.html"}'
--
-- COMO SE VUELVE ATRAS
--   drop function if exists public.set_reporte_campana(bigint, text, text);
--   y volver a correr 027_reporte_campana.sql, que deja la version de dos
--   argumentos. El campo `storage` que ya se escribio queda donde esta; la app
--   deja de poder embeber y vuelve a ofrecer solo "abrir aparte".
