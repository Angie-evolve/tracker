-- ============================================================
--  Poder borrar un trabajo y asignarlo a un cliente
--
--  Hasta ahora la lista solo crecia: cada prueba quedaba ahi para siempre. Y no
--  habia forma de saber de que cliente era cada tanda.
-- ============================================================

alter table trabajos_video
  add column if not exists cliente_id text;

comment on column trabajos_video.cliente_id is
  'Id del cliente en DB.clients del tracker. Texto porque esos ids son locales '
  'del navegador y no una FK a nada de esta base.';

create index if not exists trabajos_video_cliente_idx
  on trabajos_video (cliente_id);

-- ------------------------------------------------------------
--  Borrar lo propio
-- ------------------------------------------------------------
drop policy if exists "usuario borra sus trabajos" on trabajos_video;
create policy "usuario borra sus trabajos" on trabajos_video
  for delete using (auth.uid() = usuario_id);

-- ------------------------------------------------------------
--  Asignar cliente
--
--  El update sigue estando cerrado para todo lo demas: el estado y el resultado
--  los escribe solo el worker. La policy sola no alcanza para eso —RLS es por
--  fila, no por columna— asi que el permiso se da columna por columna.
-- ------------------------------------------------------------
drop policy if exists "usuario etiqueta sus trabajos" on trabajos_video;
create policy "usuario etiqueta sus trabajos" on trabajos_video
  for update using (auth.uid() = usuario_id)
  with check (auth.uid() = usuario_id);

revoke update on trabajos_video from authenticated;
grant update (cliente_id) on trabajos_video to authenticated;
grant delete on trabajos_video to authenticated;

-- ------------------------------------------------------------
--  Borrar los archivos, no solo la fila
--
--  Sin esto la fila desaparece de la pantalla y los videos siguen ocupando el
--  bucket, que en el plan Free se llena.
-- ------------------------------------------------------------
drop policy if exists "videos: borrar lo propio" on storage.objects;
create policy "videos: borrar lo propio" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
