-- ============================================================================
-- 007_patrones.sql
--
-- QUE ARREGLA — tres cosas que salieron de correr las pruebas del 006:
--
--   1. `etapa_sin_leads` quedo ejecutable por `anon`. No es explotable
--      (devuelve `trigger`, Postgres no deja invocarla directo) pero rompe la
--      regla de "anon no puede ejecutar ninguna". Una regla con una excepcion
--      conocida deja de servir para detectar la proxima.
--
--   2. Un typo en GHL manda un lead descartado a una etapa activa:
--      "No asisitó a llamada" cae en `reunion1`, porque el patron `no asisti`
--      no matchea el typo y lo agarra `llamada`. Agregar typos a mano no
--      escala. Va una regla: si el texto arranca con "no ", no puede terminar
--      en una etapa de grupo `nuevo` o `avanzando`.
--
--   3. 124 de 1822 oportunidades (6,8%) quedaron sin traducir. Se agregan los
--      patrones que faltan. "Oferta presentada" son 23 que son exactamente
--      `presentacion` y caian en `nuevo`.
--
-- TODO ES ADITIVO. Es un `create or replace` y varios `update` a un array.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — Cerrar el permiso que quedo abierto
-- ════════════════════════════════════════════════════════════════════════════

revoke all on function public.etapa_sin_leads() from public, anon;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — La regla del "no "
--
-- Un texto que arranca con "no " esta diciendo que algo NO pasó. Si el patron
-- que matcheo pertenece a una etapa activa (`nuevo` o `avanzando`), es un
-- falso positivo: gano un patron ancho como `llamada` o `reunion`.
--
-- En ese caso devolvemos NULL en vez de adivinar. NO es lo mismo:
--   - mal traducido -> el lead queda en una etapa que no le corresponde y
--                      nadie se entera nunca
--   - sin traducir  -> cae en 'nuevo' Y aparece marcado en el reporte 6.c
-- Ante la duda, que se note.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.etapa_desde_ghl(p_stage text, p_cliente text default null)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare t text; r record; pat text;
begin
  if p_stage is null or btrim(p_stage) = '' then return null; end if;

  t := lower(btrim(p_stage));
  t := translate(t, 'áéíóúàèìòùäëïöüâêîôûñ', 'aeiouaeiouaeiouaeioun');

  for r in select * from public.etapas_de(p_cliente) where activa order by prioridad loop
    foreach pat in array r.ghl_patrones loop
      if t like '%' || pat || '%' then

        -- ⚠️ La regla del "no ": un texto que empieza negando no puede caer en
        --    una etapa activa. Si pasa, gano un patron ancho y es falso
        --    positivo. Mejor sin traducir (se ve en el reporte) que mal
        --    traducido (no se ve nunca).
        if t like 'no %' and r.grupo in ('nuevo','avanzando') then
          return null;
        end if;

        return r.slug;
      end if;
    end loop;
  end loop;

  return null;
end $$;

revoke all     on function public.etapa_desde_ghl(text, text) from public, anon;
grant  execute on function public.etapa_desde_ghl(text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — Los patrones que faltaban
--
-- Solo sobre la plantilla (cliente_id is null). Si algun cliente ya tiene
-- etapas propias, las suyas no se tocan: son suyas.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- "Oferta presentada" (23) — la mas importante: son `presentacion` y caian
-- en `nuevo`. Los patrones eran `presentaci` y `propuesta`; ninguno matchea.
update public.etapas set ghl_patrones = ghl_patrones ||
  array['presentad','oferta']
 where cliente_id is null and slug = 'presentacion';

-- "Canceladas (menos de 200 facturas...)" (31), "No completó formulario" (9),
-- "Error de envío" (36). Los tres son descartes, no etapas del embudo.
-- `no completo` va explicito: si no, la regla del "no " lo deja sin traducir.
update public.etapas set ghl_patrones = ghl_patrones ||
  array['cancelad','no completo','no complet','error de envio','invalid','duplicad']
 where cliente_id is null and slug = 'no_califica';

-- "Solicitó informe por WhatsApp" (5), "Vio informe" (4), "Hot Lead" (3),
-- "Contactar en 30 días" (9) — todos son contacto vivo sin reunion agendada.
-- "Calendario enviado esperando agenda" aparecio recien, al arreglar el token
-- de Zentenio: son 267 oportunidades que no existian cuando se conto el 6,8%.
update public.etapas set ghl_patrones = ghl_patrones ||
  array['informe','hot lead','contactar','nurtur','calentand',
        'calendario','esperando agenda','link enviado']
 where cliente_id is null and slug = 'programando';

-- "Asistió" (3), "Reagendar" (1) — la reunion existe o se esta reprogramando.
update public.etapas set ghl_patrones = ghl_patrones ||
  array['asistio','reagend','confirmad']
 where cliente_id is null and slug = 'reunion1';

-- El typo "No asisitó". La regla del "no " ya evita que caiga en `reunion1`,
-- pero asi ademas cae donde corresponde en vez de quedar sin traducir.
update public.etapas set ghl_patrones = ghl_patrones ||
  array['asisit','no asis','ausent']
 where cliente_id is null and slug = 'no_asistio';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — Comprobar. Se mira a ojo, no cambia nada.
-- ════════════════════════════════════════════════════════════════════════════

-- 4.a — Las 14 de siempre tienen que seguir dando igual.
--       ⚠️ Esto es lo que mas me importa: los patrones nuevos NO pueden
--          robarle leads a las etapas que ya traducian bien.
select t.entra,
       public.etapa_desde_ghl(t.entra) as sale,
       t.espero,
       case when public.etapa_desde_ghl(t.entra) is not distinct from t.espero
            then '✅' else '❌ REGRESION' end as ok
from (values
  ('Nuevo Lead',                  'nuevo'),
  ('No respondió',                'no_respondio'),
  ('Primera llamada programada',  'reunion1'),
  ('1ra llamada programada',      'reunion1'),
  ('Llamada Agendada',            'reunion1'),
  ('Llamada agendada',            'reunion1'),
  ('No Calificado',               'no_califica'),
  ('No Califica',                 'no_califica'),
  ('Lead no calificado',          'no_califica'),
  ('No compró',                   'no_compro'),
  ('Respondió',                   'programando'),
  ('Tomando la desición',         'decidiendo'),
  ('Tomando desición',            'decidiendo'),
  ('Tomando Decisión',            'decidiendo')
) as t(entra, espero);


-- 4.b — Las que arregla este archivo.
select t.entra,
       public.etapa_desde_ghl(t.entra) as sale,
       t.espero,
       case when public.etapa_desde_ghl(t.entra) is not distinct from t.espero
            then '✅' else '❌' end as ok
from (values
  ('Oferta presentada',                          'presentacion'),
  ('Canceladas (menos de 200 facturas al mes)',  'no_califica'),
  ('No completó formulario',                     'no_califica'),
  ('Error de envío',                             'no_califica'),
  ('Solicitó informe por WhatsApp',              'programando'),
  ('Vio informe',                                'programando'),
  ('Hot Lead',                                   'programando'),
  ('Contactar en 30 días',                       'programando'),
  ('Asistió',                                    'reunion1'),
  ('Asistió a llamada',                          'reunion1'),
  ('Reagendar',                                  'reunion1'),
  ('Calendario enviado esperando agenda',        'programando'),
  ('No asisitó a llamada',                       'no_asistio')   -- con el typo
) as t(entra, espero);


-- 4.c — Cuanto queda sin traducir ahora. Antes: 124 de 1822 (6,8%).
select
  count(*)                                                          as total,
  count(*) filter (where public.etapa_desde_ghl(op->>'pipelineStage') is null) as sin_traducir,
  round(100.0 * count(*) filter (where public.etapa_desde_ghl(op->>'pipelineStage') is null)
        / nullif(count(*),0), 1)                                    as pct
from public.clientes c,
     lateral jsonb_array_elements(
       coalesce(c.datos->'ghl'->'opportunities', '[]'::jsonb)
     ) as op;


-- 4.d — Que quedo sin traducir, por volumen.
select op->>'pipelineStage' as stage_ghl, count(*) as n
from public.clientes c,
     lateral jsonb_array_elements(
       coalesce(c.datos->'ghl'->'opportunities', '[]'::jsonb)
     ) as op
where public.etapa_desde_ghl(op->>'pipelineStage') is null
group by 1 order by n desc;


-- 4.e — Que ninguna quedo mal traducida a una etapa activa empezando con "no ".
--       Tiene que devolver CERO filas.
select op->>'pipelineStage' as stage_ghl,
       public.etapa_desde_ghl(op->>'pipelineStage') as cayo_en,
       count(*) as n
from public.clientes c,
     lateral jsonb_array_elements(
       coalesce(c.datos->'ghl'->'opportunities', '[]'::jsonb)
     ) as op
where lower(btrim(op->>'pipelineStage')) like 'no %'
  and public.etapa_desde_ghl(op->>'pipelineStage') in (
        select slug from public.etapas
         where cliente_id is null and grupo in ('nuevo','avanzando'))
group by 1, 2;

-- ⚠️ CERO filas. Si aparece alguna, la regla del "no " no esta funcionando.


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — Como volver atras
-- ════════════════════════════════════════════════════════════════════════════
/*
-- Los patrones: se quitan los agregados, quedan los originales del 006.
begin;
  update public.etapas set ghl_patrones = array['presentaci','propuesta']
   where cliente_id is null and slug = 'presentacion';
  update public.etapas set ghl_patrones = array['no califica','no calificad','descartad']
   where cliente_id is null and slug = 'no_califica';
  update public.etapas set ghl_patrones = array['respondi','contacto','contactad','interesad']
   where cliente_id is null and slug = 'programando';
  update public.etapas set ghl_patrones = array['primera','1ra','1era','agendad','programad','reunion','llamada','meeting']
   where cliente_id is null and slug = 'reunion1';
  update public.etapas set ghl_patrones = array['no asisti','no se presento','no show']
   where cliente_id is null and slug = 'no_asistio';
commit;

-- La regla del "no ": volver a poner la version del 006 (sacar el bloque
-- `if t like 'no %' ...`). El grant de etapa_sin_leads a anon no se restaura:
-- no lo queremos de vuelta.
*/
-- ============================================================================
