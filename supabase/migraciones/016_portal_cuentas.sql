-- ============================================================================
-- 016_portal_cuentas.sql
--
-- QUE AGREGA
-- Una funcion para que el tracker pueda mostrar, en la ficha del cliente, si
-- ese cliente tiene cuenta del portal, con que mail entra, y si ya entro
-- alguna vez.
--
-- ⚠️  EL DATO DEL ULTIMO ACCESO VIVE EN `auth.users`, que es el esquema de
--     Supabase Auth. Ahi tambien viven los hashes de las contrasenas, los
--     tokens de recuperacion, los factores MFA y los mails de TODOS los
--     usuarios, incluidos los de la agencia.
--
--     Por eso la funcion devuelve TRES COLUMNAS y nada mas, y filtra por
--     cliente. No se le da a nadie acceso a la tabla: es el mismo criterio
--     que `mi_cliente_nombre()` del 015 con `clientes.datos`.
--
-- ⚠️  `last_sign_in_at` lo mantiene Supabase Auth solo. No lo escribe nadie de
--     nuestro lado, asi que no se puede quedar viejo por un bug nuestro. Si
--     dice NULL es que la cuenta se creo y esa persona nunca entro.
--
-- SOLO AGENCIA, y corta con excepcion en vez de devolver cero filas. Cero
-- filas ya significa otra cosa acá: "este cliente no tiene cuenta". Si el
-- guarda devolviera lo mismo, la pantalla mostraria "sin cuenta" a alguien
-- que en realidad no tiene permiso, y nadie se enteraria del problema.
--
-- TODO ES ADITIVO. Una funcion nueva.
-- ============================================================================

create or replace function public.portal_cuentas(p_cliente text)
returns table (
  email          text,
  nombre         text,
  creada_at      timestamptz,
  ultimo_acceso  timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.es_agencia() then
    raise exception 'Solo la agencia puede ver las cuentas del portal';
  end if;

  return query
    select u.email::text,
           p.nombre,
           u.created_at,
           u.last_sign_in_at
      from public.perfiles p
      join auth.users u on u.id = p.user_id
     where p.rol = 'cliente'
       and p.cliente_id = p_cliente
     order by u.created_at;
end $$;

revoke all     on function public.portal_cuentas(text) from public, anon;
grant  execute on function public.portal_cuentas(text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Permisos.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='portal_cuentas';

-- ⚠️  anon_puede = false.


-- b — Como agencia, devuelve la cuenta del cliente que se le pida.
--     (Se corre simulando un perfil de agencia; ver el LEEME de pruebas.)
select * from public.portal_cuentas('1787576119851');


-- c — ⭐ LA IMPORTANTE: un cliente logueado NO puede usarla, ni para ver la
--     suya ni para ver la de otro. Tiene que cortar con excepcion las dos
--     veces, no devolver cero filas.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
drop function if exists public.portal_cuentas(text);
*/
-- ============================================================================
