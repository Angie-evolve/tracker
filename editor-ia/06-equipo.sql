-- ============================================================
--  Que las dos vean todo, y guardar las palabras para poder comparar
--
--  Hasta ahora cada una veia solo lo suyo, asi que la colaboradora entraba al
--  Editor y lo veia vacio: no podia corregir lo que no veia.
--
--  El equipo se define por MAIL y no por uuid a proposito: asi se puede sumar a
--  alguien antes de que entre por primera vez. El uuid recien existe despues del
--  primer login.
-- ============================================================

create table if not exists equipo_video (
  email       text primary key,
  agregado_at timestamptz default now()
);

insert into equipo_video (email) values
  ('mdlangierh@gmail.com'),
  ('demartinmarquez@gmail.com')
on conflict (email) do nothing;

alter table equipo_video enable row level security;
drop policy if exists "el equipo se ve" on equipo_video;
create policy "el equipo se ve" on equipo_video for select using (true);
grant select on equipo_video to authenticated;
grant select, insert, delete on equipo_video to service_role;

-- Una sola definicion de "es del equipo", para que las policies no se copien
-- la condicion y despues queden desincronizadas.
create or replace function es_del_equipo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from equipo_video
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ------------------------------------------------------------
--  Las palabras con sus tiempos. Sin esto no se puede comparar una version
--  corregida contra la original: hace falta saber en que momento se dijo cada
--  palabra, y el texto plano que se guardaba no lo dice.
-- ------------------------------------------------------------
alter table trabajos_video
  add column if not exists palabras jsonb,
  add column if not exists corrige  uuid references trabajos_video(id) on delete set null;

comment on column trabajos_video.palabras is
  'Transcripcion con tiempos por palabra del material original.';
comment on column trabajos_video.corrige is
  'Si esta fila es una correccion, a que trabajo corrige.';

-- ------------------------------------------------------------
--  Ver y administrar lo del equipo. Escribir sigue siendo de cada una en su
--  propia carpeta: compartir la vista no es compartir la firma.
-- ------------------------------------------------------------
drop policy if exists "usuario ve sus trabajos"       on trabajos_video;
drop policy if exists "usuario borra sus trabajos"    on trabajos_video;
drop policy if exists "usuario etiqueta sus trabajos" on trabajos_video;

create policy "el equipo ve los trabajos" on trabajos_video
  for select using (auth.uid() = usuario_id or es_del_equipo());
create policy "el equipo borra trabajos" on trabajos_video
  for delete using (auth.uid() = usuario_id or es_del_equipo());
create policy "el equipo etiqueta trabajos" on trabajos_video
  for update using (auth.uid() = usuario_id or es_del_equipo())
  with check (auth.uid() = usuario_id or es_del_equipo());

drop policy if exists "ve sus ejemplos" on ejemplos_edicion;
create policy "el equipo ve los ejemplos" on ejemplos_edicion
  for select using (auth.uid() = usuario_id or es_del_equipo());

-- Storage: leer y borrar lo del equipo; subir, solo a la carpeta propia.
drop policy if exists "videos: leer lo propio"   on storage.objects;
drop policy if exists "videos: borrar lo propio" on storage.objects;

create policy "videos: el equipo lee" on storage.objects
  for select to authenticated
  using (bucket_id = 'videos'
         and ((storage.foldername(name))[1] = auth.uid()::text or es_del_equipo()));

create policy "videos: el equipo borra" on storage.objects
  for delete to authenticated
  using (bucket_id = 'videos'
         and ((storage.foldername(name))[1] = auth.uid()::text or es_del_equipo()));
