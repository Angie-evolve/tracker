-- ============================================================
--  Banco de ejemplos - Editor con IA
--  Supabase -> SQL Editor -> New query -> pegar todo -> Run.
--
--  Una fila por cada corte que alguien marco. Es el unico lugar donde queda
--  registrado el gusto: hoy, cuando un corte sale mal, la correccion pasa por
--  CapCut y se pierde.
--
--  Va en tabla aparte y no adentro de trabajos_video a proposito: esa la
--  escribe solo el worker (los usuarios no tienen policy de update), y ademas
--  el banco tiene que poder leerse cruzando todos los trabajos.
-- ============================================================

create table if not exists ejemplos_edicion (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid references auth.users(id) not null default auth.uid(),
  pedido_por  text default (auth.jwt() ->> 'email'),
  trabajo_id  uuid references trabajos_video(id) on delete cascade,
  formato     text,
  -- De donde salio el corte: silencio | muletilla | repetida | plano
  motivo      text,
  inicio      numeric,
  fin         numeric,
  -- Lo que se decia ahi. Es lo que hace que el ejemplo sirva de ejemplo: sin el
  -- texto queda un par de numeros que no le dicen nada a nadie.
  texto       text,
  -- bien    -> el corte estuvo bien
  -- no_iba  -> se llevo algo que tenia que quedar
  -- faltaba -> aca habia que cortar y no se corto
  veredicto   text not null check (veredicto in ('bien','no_iba','faltaba')),
  nota        text,
  creado_at   timestamptz default now()
);

create index if not exists ejemplos_edicion_formato_idx
  on ejemplos_edicion (formato, motivo, veredicto);

alter table ejemplos_edicion enable row level security;

drop policy if exists "ve sus ejemplos"     on ejemplos_edicion;
drop policy if exists "crea sus ejemplos"   on ejemplos_edicion;
drop policy if exists "cambia sus ejemplos" on ejemplos_edicion;
drop policy if exists "borra sus ejemplos"  on ejemplos_edicion;

create policy "ve sus ejemplos" on ejemplos_edicion
  for select using (auth.uid() = usuario_id);
create policy "crea sus ejemplos" on ejemplos_edicion
  for insert with check (auth.uid() = usuario_id);
-- Marcar es cambiar de opinion todo el tiempo, asi que se puede corregir y
-- borrar lo propio. En trabajos_video no hace falta porque eso lo escribe el
-- worker, aca lo escribe la persona.
create policy "cambia sus ejemplos" on ejemplos_edicion
  for update using (auth.uid() = usuario_id) with check (auth.uid() = usuario_id);
create policy "borra sus ejemplos" on ejemplos_edicion
  for delete using (auth.uid() = usuario_id);

-- Los GRANT por defecto no estan puestos en este proyecto: sin esto da 42501.
grant select, insert, update, delete on ejemplos_edicion to authenticated;
grant select, insert, update, delete on ejemplos_edicion to service_role;
