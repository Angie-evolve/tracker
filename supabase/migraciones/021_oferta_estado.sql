-- ============================================================================
-- 021_oferta_estado.sql
--
-- QUE CAMBIA
-- 1. La columna "Oferta" del portal pasa a tener CUATRO estados:
--        Pendiente · Programada · Sí · No
--    Antes tenia tres. El que falta es "Programada".
-- 2. La etapa "Presentación programada" se ARCHIVA: deja de ofrecerse.
--
-- Son la misma cosa mirada dos veces. "Presentación programada" era una etapa
-- del embudo que en realidad no decia donde esta el lead sino que paso con la
-- oferta. Ahora eso lo dice la columna de la oferta, que es donde vive.
--
-- ⚠️  TERCERA COLUMNA PARA LO MISMO, Y LO DIGO YO PRIMERO:
--       `presento_en`        (017) — numero de reunion. Forma equivocada.
--       `oferta_presentada`  (019) — boolean. Tres estados, y hacen falta 4.
--       `oferta_estado`      (021) — texto. Los cuatro, y el proximo es un
--                                    check mas, no una columna mas.
--     Un boolean tiene tres estados y ya estaban los tres usados, asi que
--     "Programada" no entraba de ninguna forma. `presento_en` esta vacia y
--     `oferta_presentada` tiene DOS filas. Las dos son candidatas a borrar y
--     estan anotadas en LIMPIEZA.md; un `drop` necesita permiso.
--
-- ⚠️  PARA QUE LAS DOS NO SE CONTRADIGAN mientras `oferta_presentada` siga
--     existiendo, LAS DOS FUNCIONES ESCRIBEN LAS DOS COLUMNAS. La vieja
--     tambien. Asi no hay forma de que una diga una cosa y la otra, otra.
--     `oferta_estado` es la verdad; `oferta_presentada` queda por si algo
--     que no encontre todavia la lee.
--
-- TODO ES ADITIVO O REVERSIBLE. Una columna, un check, dos funciones, y un
-- `activa = false` que se deshace con un `activa = true`.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — la columna
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists oferta_estado text;

alter table public.leads
  drop constraint if exists leads_oferta_estado_ck;

alter table public.leads
  add constraint leads_oferta_estado_ck
  check (oferta_estado is null or oferta_estado in ('programada','si','no'));

comment on column public.leads.oferta_estado is
  'NULL = pendiente, programada = hay presentacion agendada, si = se presento, '
  'no = no se presento. En que reunion paso NO se guarda aca: sale de la etapa. '
  'Reemplaza a oferta_presentada (019), que quedo corta: un boolean no entra '
  'en cuatro estados.';

-- Las dos filas que ya habia. `oferta_at` y `oferta_por` (019) se reusan.
update public.leads
   set oferta_estado = case when oferta_presentada then 'si' else 'no' end
 where oferta_presentada is not null
   and oferta_estado is null;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — la funcion nueva
--
-- ⚠️  NO ES UNA SOBRECARGA AMBIGUA. La vieja recibe `p_oferta`; esta recibe
--     `p_estado`. PostgREST elige la funcion por el CONJUNTO DE NOMBRES de lo
--     que le mandan, asi que con nombres distintos no hay empate. Si las dos
--     se llamaran `p_oferta`, PostgREST contestaria 300 Multiple Choices y no
--     andaria ninguna de las dos.
--
-- Guardas iguales a lead_etapa, lead_datos, lead_calificar y lead_oferta,
-- palabra por palabra.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_oferta_estado(
  p_lead_id uuid,
  p_estado  text default null,       -- 'programada' | 'si' | 'no'
  p_borrar  boolean default false)   -- true = volver a Pendiente
returns void language plpgsql security definer set search_path = public
as $$
declare v_lead_cli text; v_es_agencia boolean; v_cliente text;
begin
  v_es_agencia := public.es_agencia();          -- nunca NULL
  v_cliente    := public.mi_cliente();

  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;

  if v_lead_cli is null then
    raise exception 'Ese lead no existe';
  end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli is distinct from v_cliente) then
    raise exception 'Ese lead no existe';
  end if;

  -- `p_borrar` existe para poder volver a Pendiente. Sin el no habria forma:
  -- pasar NULL en `p_estado` es indistinguible de no pasar nada.
  if not p_borrar and p_estado is null then
    raise exception 'Falta decir como esta la oferta (programada, si o no)';
  end if;
  if not p_borrar and p_estado not in ('programada','si','no') then
    raise exception 'Estado de oferta invalido: % (programada / si / no)', p_estado;
  end if;

  update public.leads
     set oferta_estado = case when p_borrar then null else p_estado end,
         -- Se escribe tambien la vieja para que no se puedan contradecir.
         -- 'programada' cae en NULL ahi: todavia no se presento.
         oferta_presentada = case
           when p_borrar          then null
           when p_estado = 'si'   then true
           when p_estado = 'no'   then false
           else                        null
         end,
         oferta_at  = now(),
         oferta_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_oferta_estado(uuid, text, boolean) from public, anon;
grant  execute on function public.lead_oferta_estado(uuid, text, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — la funcion vieja, que ahora escribe las dos columnas
--
-- Es la misma firma, asi que es un `create or replace`, no una funcion nueva
-- ni un `drop`. Nadie que la llame se entera; lo unico que cambia es que
-- ademas deja `oferta_estado` en su lugar.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_oferta(
  p_lead_id uuid,
  p_oferta boolean default null,
  p_borrar boolean default false)
returns void language plpgsql security definer set search_path = public
as $$
declare v_lead_cli text; v_es_agencia boolean; v_cliente text;
begin
  v_es_agencia := public.es_agencia();
  v_cliente    := public.mi_cliente();

  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;

  if v_lead_cli is null then
    raise exception 'Ese lead no existe';
  end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli is distinct from v_cliente) then
    raise exception 'Ese lead no existe';
  end if;
  if not p_borrar and p_oferta is null then
    raise exception 'Falta decir si la oferta se presento (true o false)';
  end if;

  update public.leads
     set oferta_presentada = case when p_borrar then null else p_oferta end,
         oferta_estado = case
           when p_borrar    then null
           when p_oferta    then 'si'
           else                  'no'
         end,
         oferta_at  = now(),
         oferta_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_oferta(uuid, boolean, boolean) from public, anon;
grant  execute on function public.lead_oferta(uuid, boolean, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — archivar "Presentación programada"
--
-- ⚠️  SE ARCHIVA, NO SE BORRA. `etapa_borrar` hace un `delete` de la fila:
--     el nombre desaparece y no vuelve. Con `activa = false` la etapa deja de
--     ofrecerse —el portal filtra por `activa`, y `etapa_desde_ghl` tambien—
--     pero la fila sigue ahi, asi que el nombre se puede seguir leyendo y
--     volver atras es un UPDATE.
--
-- ⚠️  LOS CUATRO LEADS QUE ESTABAN AHI SE MUEVEN. Si no, apuntarian a una
--     etapa archivada: el portal no la encuentra en su lista y termina
--     mostrando el slug crudo, "presentacion".
--
--     Van a `asistio1` y se les pone la oferta en 'programada'. Ese es el
--     traslado fiel: lo que "Presentación programada" decia era que la oferta
--     estaba agendada, y eso ahora se dice en la columna de la oferta. Lo
--     unico que se agrega es que la primera reunion paso, que es lo minimo
--     que tiene que haber pasado para agendar una presentacion.
--
--     Son cuatro, los cuatro de Zentenio y los cuatro en `abandoned`, y
--     ninguno tiene `etapa_at`: ninguno fue tocado nunca desde el portal.
--
-- ⚠️  LOS PATRONES DE GHL de esta etapa —'presentaci', 'propuesta',
--     'presentad', 'oferta'— dejan de matchear, porque `etapa_desde_ghl`
--     recorre solo las activas. HOY NO ROMPE NADA: no existe ninguna
--     sincronizacion automatica que llame a esa funcion; los leads entraron a
--     mano. El dia que se escriba, "Presentación"/"Propuesta" tiene que poner
--     `oferta_estado = 'programada'`, no una etapa. Queda en LIMPIEZA.md.
-- ════════════════════════════════════════════════════════════════════════════

begin;

update public.leads
   set etapa_portal  = 'asistio1',
       oferta_estado = 'programada',
       oferta_at     = now()
 where etapa_portal = 'presentacion';

update public.etapas
   set activa = false
 where cliente_id is null and slug = 'presentacion';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — La columna, el check y las dos columnas sin contradecirse.
select count(*)                                                      as leads,
       count(oferta_estado)                                          as con_oferta,
       count(*) filter (where oferta_estado = 'programada')          as programada,
       count(*) filter (where oferta_estado = 'si')                  as si,
       count(*) filter (where oferta_estado = 'no')                  as no,
       count(*) filter (where
            (oferta_presentada is true  and oferta_estado is distinct from 'si')
         or (oferta_presentada is false and oferta_estado is distinct from 'no')
         or (oferta_presentada is null  and oferta_estado is not null
                                       and oferta_estado <> 'programada'))
                                                                     as se_contradicen
  from public.leads;

-- ⚠️  se_contradicen = 0.
--
--     Ojo con la version obvia de este chequeo, que escribi primero y dio 281
--     de 287: `(oferta_estado = 'si') is distinct from (oferta_presentada is
--     true)`. Con las dos columnas en NULL, el lado izquierdo es NULL y el
--     derecho es false, y `NULL is distinct from false` es TRUE. Contaba como
--     contradiccion a los 281 leads que no tienen oferta cargada.


-- b — Nadie quedo apuntando a una etapa que no se puede mostrar.
select l.etapa_portal, count(*) as leads, e.activa
  from public.leads l
  left join public.etapas e on e.slug = l.etapa_portal and e.cliente_id is null
 group by 1, 3 order by 2 desc;

-- ⚠️  Ninguna fila con activa = false ni con activa = NULL.


-- c — "Presentación programada" ya no se ofrece, y GHL ya no la elige.
select slug, nombre, activa from public.etapas
 where cliente_id is null and slug = 'presentacion';
select public.etapa_desde_ghl('Presentación programada') as adonde_va_ahora,
       public.etapa_desde_ghl('Propuesta enviada')       as propuesta_va_ahora;

-- ⚠️  activa = false.
--
--     `propuesta_va_ahora` = NULL, como se esperaba.
--
--     Pero `adonde_va_ahora` = 'reunion1', NO NULL, y conviene saber por que:
--     `reunion1` tiene el patron 'programad', y "Presentación programada"
--     termina en "programada". Asi que si mañana GHL manda esa etapa, el lead
--     cae en "Primera reunión programada", que dice algo distinto y mas atras.
--
--     HOY NO MUEVE NADA —no hay sincronizacion: ni pg_cron, ni triggers en
--     `leads`, ni workflow; el ultimo lead entro a mano el 19/09— pero es una
--     trampa para el dia que se escriba. No la desarmo aca: sacarle
--     'programad' a `reunion1` cambia adonde caen leads que hoy caen bien, y
--     eso es su propia migracion con la prueba 1 del 006 al lado. Queda
--     anotado en LIMPIEZA.md.


-- d — Las 14 traducciones del 006, que no se movio ninguna otra.
select t.entra, public.etapa_desde_ghl(t.entra) as sale, t.espero,
       case when public.etapa_desde_ghl(t.entra) is not distinct from t.espero
            then '✅' else '❌ REGRESION' end as ok
from (values
  ('Nuevo Lead','nuevo'),                  ('No respondió','no_respondio'),
  ('Primera llamada programada','reunion1'),('1ra llamada programada','reunion1'),
  ('Llamada Agendada','reunion1'),         ('Llamada agendada','reunion1'),
  ('No Calificado','no_califica'),         ('No Califica','no_califica'),
  ('Lead no calificado','no_califica'),    ('No compró','no_compro'),
  ('Respondió','programando'),             ('Tomando la desición','decidiendo'),
  ('Tomando desición','decidiendo'),       ('Tomando Decisión','decidiendo')
) as t(entra, espero);

-- ⚠️  Las 14 en ✅. Ninguna usaba `presentacion`.


-- e — `anon` no puede ejecutar ninguna de las dos.
select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('lead_oferta','lead_oferta_estado');

-- ⚠️  anon_puede = false en las dos.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- Los cuatro leads vuelven a `presentacion` mirando `oferta_at`: es el sello
-- que les puso esta migracion. Si alguien les toco la oferta despues, ese
-- lead ya no vuelve solo, y esta bien que no vuelva.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  update public.etapas set activa = true
   where cliente_id is null and slug = 'presentacion';

  update public.leads
     set etapa_portal  = 'presentacion',
         oferta_estado = null
   where etapa_portal = 'asistio1'
     and oferta_estado = 'programada'
     and oferta_por is null;

  drop function if exists public.lead_oferta_estado(uuid, text, boolean);
  alter table public.leads drop constraint if exists leads_oferta_estado_ck;
  alter table public.leads drop column if exists oferta_estado;
commit;
-- y `lead_oferta` vuelve a la version del 019, que esta entera en ese archivo.
*/
-- ============================================================================
