-- ============================================================
--  Editor con IA - tabla de trabajos + bucket
--  Supabase -> SQL Editor -> New query -> pegar todo -> Run.
--
--  Antes de correrlo: crear el bucket en Storage -> New bucket, nombre
--  "videos", PRIVADO (sin "Public bucket"). Las policies de abajo asumen eso.
--
--  Los nombres siguen lo que ya usa el proyecto:
--    - ia_jobs (la otra cola con worker): estado / creado_at / tomado_at /
--      listo_at / error, y pedido_por con el mail para poder leer la tabla en
--      el dashboard sin cruzar uuids.
--    - material (los archivos de cliente): en la fila va el PATH dentro del
--      bucket, no una URL. El bucket es privado y la app firma la URL en el
--      momento de descargar. Por eso resultado_path y no resultado_url.
-- ============================================================

create table if not exists trabajos_video (
  id                 uuid primary key default gen_random_uuid(),
  -- Los llena Postgres con los datos del token de quien inserta: asi el
  -- frontend no tiene que abrir el JWT para sacar el uuid, y no hay forma de
  -- crear un trabajo a nombre de otro.
  usuario_id         uuid references auth.users(id) not null default auth.uid(),
  pedido_por         text default (auth.jwt() ->> 'email'),
  video_path         text not null,
  modo               text not null check (modo in ('render','capcut')),
  estado             text not null default 'pendiente'
                       check (estado in ('pendiente','procesando','listo','error')),
  resultado_path     text,
  resultado_srt_path text,
  -- Los dos controles de la pantalla: umbral_db y min_silencio. Van en jsonb
  -- para no agregar una columna cada vez que aparezca una perilla nueva.
  opciones           jsonb,
  -- Lo que el worker va calculando, para que la pantalla muestre numeros
  -- reales en vez de un spinner mudo: duracion, silencios, cuanto se ahorro.
  analisis           jsonb,
  error              text,
  creado_at          timestamptz default now(),
  tomado_at          timestamptz,
  listo_at           timestamptz
);

-- El worker pregunta por esto en cada vuelta.
create index if not exists trabajos_video_estado_idx
  on trabajos_video (estado, creado_at);

alter table trabajos_video enable row level security;

drop policy if exists "usuario ve sus trabajos"   on trabajos_video;
drop policy if exists "usuario crea sus trabajos" on trabajos_video;

create policy "usuario ve sus trabajos" on trabajos_video
  for select using (auth.uid() = usuario_id);

create policy "usuario crea sus trabajos" on trabajos_video
  for insert with check (auth.uid() = usuario_id);

-- No hay policy de update para los usuarios a proposito: el estado y el
-- resultado los escribe solo el worker, que entra con la service_role key y se
-- saltea RLS. Por eso esa key nunca puede estar en el frontend.

-- ------------------------------------------------------------
--  Permisos de tabla. En este proyecto los GRANT por defecto no estan puestos:
--  clientes y lp_eventos le contestan "permission denied for table" (42501) a
--  service_role. Sin esto el worker falla aunque la key sea la correcta.
-- ------------------------------------------------------------
grant select, insert on trabajos_video to authenticated;
grant select, insert, update, delete on trabajos_video to service_role;

-- ------------------------------------------------------------
--  Storage. Cada uno escribe y lee solo adentro de su propia carpeta, que se
--  llama como su uuid: videos/<uuid>/<archivo>. El worker entra con
--  service_role, que se saltea todo esto y no necesita policy.
-- ------------------------------------------------------------
drop policy if exists "videos: subir a lo propio" on storage.objects;
drop policy if exists "videos: leer lo propio"    on storage.objects;

create policy "videos: subir a lo propio" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "videos: leer lo propio" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
