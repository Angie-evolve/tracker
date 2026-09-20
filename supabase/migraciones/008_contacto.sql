-- ============================================================================
-- 008_contacto.sql
--
-- QUE ARREGLA
-- El portal tiene un boton de WhatsApp por lead, que es la accion principal de
-- la pantalla. Hoy nunca se dibuja: `leads` no tiene columna de telefono.
--
-- El dato NO falta. Ya esta en `clientes.datos->'ghl'->'opportunities'`, en
-- `contactPhone`, en 2079 de 2089 oportunidades (99,5%). Lo que falta es la
-- columna donde ponerlo cuando el sync llene `leads`.
--
-- SE GUARDA CRUDO, TAL CUAL VIENE DE GHL. Nada de normalizar el numero acá:
-- si lo normalizamos mal, perdimos el original y no hay vuelta atras. El
-- arreglo del formato va en el portal, que es reversible publicando de nuevo.
--
-- ⚠️  OJO CON EL FORMATO, que afecta al boton:
--     GHL manda `+54 3544 41xxxx` — codigo de pais, area, numero. SIN EL 9.
--     WhatsApp Argentina necesita `54 9 area numero`. Sin el 9, wa.me abre un
--     chat que no existe. El portal tiene que agregarlo antes de armar el
--     link. Esto NO se arregla en la base.
--
-- POR QUE `email` SI Y `tags` NO:
-- `email` es lo mismo que el telefono — otra forma de contactar al lead, que es
-- para lo que existe el portal. `tags` no tiene ningun uso definido hoy, y
-- agregar una columna despues cuesta exactamente lo mismo que agregarla ahora.
-- Lo que cuesta es tener una columna que nadie usa: tarde o temprano alguien
-- la llena con algo y nadie sabe que significa.
--
-- TODO ES ADITIVO. Dos columnas nuevas, nada mas.
-- ============================================================================

begin;

alter table public.leads
  add column if not exists telefono text;   -- crudo, como viene de GHL

alter table public.leads
  add column if not exists email    text;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leads'
   and column_name in ('telefono','email');

-- ⚠️  Dos filas, las dos `text`.


-- ════════════════════════════════════════════════════════════════════════════
-- PARA CUANDO EL SYNC LLENE `leads` — el mapeo desde el JSON
-- ════════════════════════════════════════════════════════════════════════════
--
--   telefono     <- op->>'contactPhone'     (crudo, sin tocar)
--   email        <- op->>'contactEmail'
--   nombre       <- op->>'contactName'
--   ghl_id       <- op->>'id'
--   origen       <- op->>'source'
--   creado_at    <- op->>'createdAt'
--   estado       <- op->>'status'
--   etapa        <- op->>'pipelineStage'    (texto crudo de GHL)
--   valor        <- op->>'monetaryValue'
--   etapa_portal <- public.etapa_desde_ghl(op->>'pipelineStage', cliente_id)
--
-- ⚠️  `etapa_portal` SOLO en el INSERT, nunca en el UPDATE de un lead que ya
--     existe. Esa columna es del cliente: si el sync la pisa, le borra lo que
--     marco y nadie se entera. Es la misma razon por la que `estado` y
--     `etapa_portal` son columnas separadas.
--
--     En el upsert eso se escribe asi:
--         on conflict (cliente_id, ghl_id) do update set
--           nombre = excluded.nombre,
--           telefono = excluded.telefono,
--           ...
--           -- etapa_portal NO va acá, a proposito
--
-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  alter table public.leads drop column if exists email;
  alter table public.leads drop column if exists telefono;
commit;
*/
-- ============================================================================
