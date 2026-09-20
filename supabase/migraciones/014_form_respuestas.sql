-- ============================================================================
-- 014_form_respuestas.sql
--
-- QUE AGREGA
-- Las respuestas del formulario del lead, que hoy viven en
-- `clientes.datos->'ghl'->'opportunities'->N->'formAnswers'` y no llegan a la
-- tabla que lee el portal.
--
-- Es material de calificacion de verdad. En Albet, un lead con 10 propiedades
-- y planilla propia no es el mismo que uno con una y la app de Airbnb, y hoy
-- esa diferencia no se ve en ningun lado.
--
-- SE GUARDA CRUDO, el objeto entero tal como viene de GHL. Es la misma regla
-- del 008 con el telefono: si filtramos mal al guardar, perdimos el original y
-- no hay vuelta atras. El filtrado va en el portal, que es reversible
-- publicando de nuevo.
--
-- ⚠️  LAS PREGUNTAS SON DE CADA CLIENTE, no hay dos iguales:
--       Albet     3 preguntas sobre propiedades y calendario
--       Zentenio  facturacion, urgencia, como gestiona
--       DblandIT  etapa de la organizacion, tecnologias, presupuesto
--     Por eso es una columna `jsonb` y no columnas sueltas, y por eso el
--     portal las tiene que dibujar genericas, sin nombres de campo fijos.
--
-- TODO ES ADITIVO. Una columna y un update que la llena.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — La columna
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists form_respuestas jsonb;

comment on column public.leads.form_respuestas is
  'El objeto formAnswers de GHL, crudo. Las preguntas cambian por cliente. '
  'El filtrado de claves basura (ids de GHL, utm_*, link_origen) se hace al '
  'mostrarlo, no al guardarlo.';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Llenarla con lo que ya esta sincronizado
--
-- Se cruza por `ghl_id` = `op->>'id'`, la misma llave de siempre. Solo toca
-- los leads que ya existen: no crea ninguno.
--
-- Se saltea el objeto vacio: guardar `{}` seria decir "contesto nada", y lo
-- cierto es "no sabemos". NULL dice eso.
-- ════════════════════════════════════════════════════════════════════════════

begin;

update public.leads l
   set form_respuestas = fa.respuestas
  from (
    select op->>'id' as ghl_id,
           c.id::text as cliente_id,
           op->'formAnswers' as respuestas
      from public.clientes c,
           lateral jsonb_array_elements(
             coalesce(c.datos->'ghl'->'opportunities','[]'::jsonb)) op
     where jsonb_typeof(op->'formAnswers') = 'object'
       and op->'formAnswers' <> '{}'::jsonb
  ) fa
 where l.ghl_id = fa.ghl_id
   and l.cliente_id = fa.cliente_id;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — QUE SE FILTRA AL MOSTRAR, Y POR QUE
--
-- GHL mete en `formAnswers` tres clases de cosas mezcladas:
--
--   1. LA PREGUNTA, con su texto:
--        "¿Cuántas propiedades tenes publicadas hoy?": "10 o más"
--
--   2. LA MISMA PREGUNTA otra vez, con el id interno del campo:
--        "IeS2u5wMU3mpxvewgNqG": "10 o más"
--      Son 20 caracteres alfanumericos sin espacios. Se descartan: mostrar
--      las dos seria mostrar todo duplicado.
--
--   3. METADATA que no es una pregunta:
--        "utm_ad": "H1B1C1 con1"
--        "link_origen": "https://...?utm_source=meta&..."   (469 caracteres)
--      Se descartan. La campana y el anuncio ya se ven en la tarjeta, por sus
--      columnas propias.
--
-- ⚠️  `link_origen` aparece en un solo lead de Zentenio y es una URL larga.
--     Si mañana aparece otra clave de metadata hay que sumarla a la lista del
--     portal: no hay forma de distinguirla sola.
--
-- LO QUE SE REVISO ANTES DE MOSTRARLO GENERICO
-- Los tres clientes con formAnswers cargado son Zentenio (99), DblandIT (59)
-- y Albet (21). Se leyeron TODAS sus preguntas. No hay ninguna que no deba
-- aparecer:
--   - Son respuestas que el lead le dio al formulario DE ESE CLIENTE, y el
--     portal le muestra a cada cliente solo sus propios leads. No hay forma
--     de que uno vea el formulario de otro: lo impide la RLS de `leads`.
--   - Las mas delicadas son de facturacion ("rango de facturación mensual",
--     "Rango de facturación anual (USD)") y nombres de empresa. Son datos
--     comerciales del lead, que ese cliente ya recolecto y ya tiene.
--   - Hay un campo de texto libre, "Desglose Diagnóstico" de Zentenio, de
--     1229 caracteres: un informe generado con el nombre de la empresa y
--     puntajes. No es sensible, pero es largo, y por eso el portal lo muestra
--     en un bloque que se despliega y no en la tarjeta.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — La columna existe y es jsonb.
select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='leads' and column_name='form_respuestas';

-- b — Cuantos leads quedaron con respuestas, por cliente.
select cliente_id,
       count(*) as leads,
       count(form_respuestas) as con_respuestas
  from public.leads group by 1 order by 1;

-- ⚠️  Albet (1787576119851): 21 de 21.
--     Zentenio (1780612900204): 99 de 267.

-- c — Cuantas preguntas quedan DESPUES de filtrar, que es lo que se va a ver.
select l.cliente_id,
       count(*) as leads_con_respuestas,
       round(avg((select count(*) from jsonb_object_keys(l.form_respuestas) k
                   where k !~ '^[A-Za-z0-9]{20}$'
                     and k !~* '^utm_'
                     and k <> 'link_origen')), 1) as preguntas_promedio
  from public.leads l where l.form_respuestas is not null
 group by 1 order by 1;

-- ⚠️  Albet: 3. Sin filtrar eran 7,7.


-- ════════════════════════════════════════════════════════════════════════════
-- PARA CUANDO EL SYNC LLENE `leads` — el mapeo
-- ════════════════════════════════════════════════════════════════════════════
--   form_respuestas <- op->'formAnswers'   (crudo, sin filtrar)
--
-- Va tanto en el INSERT como en el UPDATE del upsert: no es del cliente, es
-- lo que el lead contesto. A diferencia de `etapa_portal`, pisarlo no borra
-- ninguna decision de nadie.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  alter table public.leads drop column if exists form_respuestas;
commit;
*/
-- ============================================================================
