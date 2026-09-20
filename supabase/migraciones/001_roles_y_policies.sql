-- ============================================================================
-- 001_roles_y_policies.sql
--
-- QUÉ ARREGLA: hoy las 6 policies de clientes, config y llamadas_fathom dicen
-- `true`. Cualquier usuario con cuenta lee, escribe y borra todo. Funciona
-- porque hoy son 3 cuentas de confianza. Deja de funcionar cuando hay una cuarta.
--
-- NO DEPENDE DE NINGUNA OTRA MIGRACIÓN. Se puede correr dos veces sin romper.
--
-- ORDEN OBLIGATORIO: seis partes, NO se corre de una. La parte 3 es un freno.
-- Si cambiás las policies antes de cargar los perfiles, te quedás afuera de
-- tu propia app.
-- ============================================================================

-- ── PARTE 1 — Quién es quién ────────────────────────────────────────────────

create table if not exists public.perfiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  rol        text not null default 'cliente' check (rol in ('agencia','cliente')),
  cliente_id text,
  nombre     text,
  creado_at  timestamptz not null default now()
);

alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon;

-- Una sola policy, y es de lectura del propio perfil. NO hay policy de
-- escritura para nadie: lo que no tiene policy no se puede, así que ningún
-- usuario puede cambiarse el rol a sí mismo desde la app.
drop policy if exists "perfil_propio" on public.perfiles;
create policy "perfil_propio" on public.perfiles
  for select to authenticated
  using (user_id = auth.uid());

create or replace function public.mi_rol()
returns text language sql stable security definer set search_path = public
as $$ select rol from public.perfiles where user_id = auth.uid() $$;

create or replace function public.mi_cliente()
returns text language sql stable security definer set search_path = public
as $$ select cliente_id from public.perfiles where user_id = auth.uid() $$;

-- RED DE SEGURIDAD: toda cuenta nueva nace como 'cliente' sin cliente
-- asignado, o sea sin ver nada. Si alguien crea un usuario y se olvida de
-- darle rol, el error es "no ve nada", nunca "ve todo".
create or replace function public.perfil_nuevo()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.perfiles (user_id, rol, nombre)
  values (new.id, 'cliente', new.email)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.perfil_nuevo();

-- Segundo candado. Sin policy de escritura ya no se puede escribir, pero eso
-- depende de que nadie agregue una "solo para el nombre" y de paso abra el
-- ascenso a 'agencia'. Sin el grant, no alcanza con una policy.
revoke insert, update, delete on public.perfiles from authenticated;


-- ── PARTE 2 — Marcar al equipo ──────────────────────────────────────────────
-- Las tres cuentas que existen hoy. No le saca el acceso a nadie: solo evita
-- que la PRÓXIMA cuenta lo tenga automáticamente.

insert into public.perfiles (user_id, rol, nombre)
select id, 'agencia', email
  from auth.users
 where email in (
   'mdlangierh@gmail.com',
   'ashn10291@gmail.com',
   'melany@theflowingcode.com'
 )
on conflict (user_id) do update set rol = 'agencia';


-- ── PARTE 3 — FRENO. Correr y mirar con los ojos. ───────────────────────────

select u.email, coalesce(p.rol, '(SIN PERFIL)') as rol
  from auth.users u
  left join public.perfiles p on p.user_id = u.id
 order by u.email;

-- Las tres TIENEN que decir 'agencia'. Si alguna dice otra cosa, volver a la
-- parte 2. NO SEGUIR a la parte 4 hasta que esto esté bien.


-- ── PARTE 4 — Las cerraduras nuevas. Todo junto o nada. ─────────────────────

begin;

  drop policy if exists "escribir clientes" on public.clientes;
  drop policy if exists "leer clientes"     on public.clientes;
  create policy "agencia_clientes" on public.clientes
    for all to authenticated
    using      (public.mi_rol() = 'agencia')
    with check (public.mi_rol() = 'agencia');

  drop policy if exists "escribir config" on public.config;
  drop policy if exists "leer config"     on public.config;
  create policy "agencia_config" on public.config
    for all to authenticated
    using      (public.mi_rol() = 'agencia')
    with check (public.mi_rol() = 'agencia');

  drop policy if exists "equipo lee"   on public.llamadas_fathom;
  drop policy if exists "equipo marca" on public.llamadas_fathom;
  create policy "agencia_fathom_lee" on public.llamadas_fathom
    for select to authenticated
    using (public.mi_rol() = 'agencia');
  create policy "agencia_fathom_marca" on public.llamadas_fathom
    for update to authenticated
    using      (public.mi_rol() = 'agencia')
    with check (public.mi_rol() = 'agencia');

commit;


-- ── PARTE 5 — Probar ────────────────────────────────────────────────────────
-- 1. Recargar el tracker: tiene que cargar los clientes y guardar un cambio.
-- 2. Que entre alguien más del equipo. Lo mismo.
-- 3. Que siga entrando una llamada de Fathom.
-- 4. Crear una cuenta descartable en Authentication -> Users. NO tocarle el
--    perfil. Entrar con ella y pedir /rest/v1/clientes?select=id
--    Tiene que devolver []  ← vacío. Si devuelve filas, correr la PARTE 6.
-- 5. Borrar esa cuenta.


-- ── PARTE 6 — Vuelta atrás (deja todo igual que antes) ──────────────────────
/*
begin;
  drop policy if exists "agencia_clientes"     on public.clientes;
  drop policy if exists "agencia_config"       on public.config;
  drop policy if exists "agencia_fathom_lee"   on public.llamadas_fathom;
  drop policy if exists "agencia_fathom_marca" on public.llamadas_fathom;

  create policy "escribir clientes" on public.clientes
    for all to authenticated using (true) with check (true);
  create policy "leer clientes" on public.clientes
    for select to authenticated using (true);
  create policy "escribir config" on public.config
    for all to authenticated using (true) with check (true);
  create policy "leer config" on public.config
    for select to authenticated using (true);
  create policy "equipo lee" on public.llamadas_fathom
    for select to authenticated using (true);
  create policy "equipo marca" on public.llamadas_fathom
    for update to authenticated using (true) with check (true);
commit;
*/

-- NOTA DELETE: el `for all` incluye borrar, y queda para la agencia a
-- propósito: la app usa DELETE sobre `clientes` cuando se borra un cliente
-- desde el tracker. Lo que cambia es que ahora borrar exige ser agencia.
--
-- NOTA GRANTS: perfiles queda con dos candados — sin grant de escritura para
-- authenticated, y sin policy de escritura. El día que exista la pantalla de
-- Personas hay que agregar LOS DOS, en el mismo commit que la pantalla.
