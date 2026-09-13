-- ============================================================
--  Una tanda: varios videos y varios guiones en un solo trabajo
--
--  Los guiones se reparten mirando TODAS las transcripciones juntas: un guion
--  puede estar en el video 3, y un guion que no aparece en ninguno solo se
--  puede detectar comparando contra todos. Por eso la tanda es un trabajo y no
--  un trabajo por video.
--
--  video_path se mantiene y sigue siendo obligatorio: guarda el primer video,
--  asi el flujo de un video suelto sigue funcionando igual que hasta ahora.
-- ============================================================

alter table trabajos_video
  add column if not exists videos  jsonb,   -- ["uuid/a.mp4", "uuid/b.mp4", ...]
  add column if not exists guiones jsonb,   -- [{"titulo":..., "texto":...}, ...]
  add column if not exists piezas  jsonb;   -- lo que se entrega, una por guion

comment on column trabajos_video.videos  is
  'Todos los archivos de la tanda. Null o un solo elemento = video suelto.';
comment on column trabajos_video.guiones is
  'Los guiones a repartir entre esos videos, ya separados del archivo original.';
comment on column trabajos_video.piezas  is
  'Resultado: [{titulo, video, inicio, fin, path, srt_path, duracion}]';
