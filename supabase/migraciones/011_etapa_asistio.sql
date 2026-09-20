-- ============================================================================
-- 011_etapa_asistio.sql
--
-- QUE AGREGA
-- La etapa "Asistió a la primera reunión", entre "Primera reunión programada"
-- y "Segunda reunión programada".
--
-- Hoy falta el positivo: existe `no_asistio` ("No asistió a la primera
-- reunión") y no existe el que dice que sí. Un lead que asistió queda en
-- "Primera reunión programada" para siempre, igual que uno que todavía no
-- llegó a la reunión, y de afuera no se distinguen.
--
-- ⚠️  SIN PATRONES DE GHL, A PROPOSITO. Ver PARTE 3.
--
-- TODO ES ADITIVO. Una fila nueva y un renumerado de `orden`.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- COMO CORRERLO
--
-- `etapa_crear` y `etapas_reordenar` exigen `es_agencia()`, que lee el perfil
-- de `auth.uid()`. El editor SQL corre como `postgres` y SIN JWT, asi que
-- `auth.uid()` es NULL, `mi_rol()` es NULL y `es_agencia()` da false: las dos
-- funciones cortarian con "Solo la agencia puede...".
--
-- Por eso todo va adentro de UN solo bloque, que primero se hace pasar por una
-- cuenta de agencia que ya existe. El user_id se busca solo: no se escribe
-- ninguno en este archivo.
--
-- Es un bloque unico porque `set_config(..., true)` dura lo que dura la
-- transaccion. Partido en dos, el segundo pedazo ya no seria agencia.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_agencia uuid;
  v_fila    public.etapas;
begin
  select user_id into v_agencia
    from public.perfiles where rol = 'agencia' order by user_id limit 1;
  if v_agencia is null then
    raise exception 'No hay ningun perfil con rol agencia: no puedo correr esto';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_agencia, 'role', 'authenticated')::text, true);

  if not public.es_agencia() then
    raise exception 'El disfraz de agencia no funciono: es_agencia() sigue en false';
  end if;

  -- ── PARTE 1 — la etapa nueva ──────────────────────────────────────────
  -- `p_patrones` va vacio a proposito. Ver PARTE 3.
  -- `etapa_crear` la deja al final: orden 120 y prioridad 120.
  v_fila := public.etapa_crear(
    null,                               -- la plantilla, no un cliente suelto
    'asistio1',
    'Asistió a la primera reunión',
    'open',
    'avanzando',
    null,
    '{}'::text[]
  );
  raise notice 'Creada: slug=% orden=% prioridad=%',
    v_fila.slug, v_fila.orden, v_fila.prioridad;

  -- ── PARTE 2 — ponerla en su lugar ─────────────────────────────────────
  --
  -- ⚠️  ESTO NO TOCA NINGUNA `prioridad`. `etapas_reordenar` hace un
  --     `update ... set orden = pos.i * 10` y nada mas. Las prioridades de
  --     las once que ya estaban quedan como estaban (110, 100, 90, ... 10),
  --     y con ellas la traduccion desde GHL.
  --
  --     Esa separacion entre `orden` (lo que se ve) y `prioridad` (quien gana
  --     al traducir) es justamente para que mover una etapa de lugar no
  --     cambie donde caen los leads. La prueba 2 del 006 existe para eso.
  perform public.etapas_reordenar(null, array[
    'nuevo',
    'programando',
    'reunion1',
    'asistio1',        -- ← entra acá
    'reunion2',
    'presentacion',
    'decidiendo',
    'no_respondio',
    'no_asistio',
    'no_califica',
    'compro',
    'no_compro'
  ]);
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — POR QUE NO TIENE PATRONES DE GHL
--
-- El patron obvio seria `asistio`. No se puede: el 007 ya se lo dio a
-- `reunion1`, junto con `reagend` y `confirmad`.
--
-- Y aunque se lo agregaramos, no ganaria nunca. `etapa_desde_ghl` recorre las
-- etapas con `order by prioridad` ASCENDENTE y devuelve la primera que
-- matchea, asi que gana el numero MAS CHICO. `reunion1` tiene 90; la etapa
-- nueva, por venir de `etapa_crear`, tiene 120. Se evalua ultima.
--
-- Para que ganara habria que bajarle la prioridad por debajo de 90, y eso es
-- exactamente "tocar la prioridad de las que ya estan" por la puerta de atras:
-- cambiaria a donde van a parar leads que hoy caen bien.
--
-- Asi que "Asistió" desde GHL sigue cayendo en "Primera reunión programada".
-- Esta etapa se marca a mano, desde el portal o desde el tracker. Es
-- coherente con para que existe: GHL sabe que la reunion se agendo, no sabe
-- si la persona aparecio. Eso lo sabe quien estuvo.
--
-- Si mas adelante se quiere que GHL tambien la asigne, es su propia migracion:
-- sacarle `asistio` a `reunion1`, darselo a esta, y ahi si mover prioridades
-- con la prueba 1 del 006 al lado para ver que no se rompa nada.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — El orden visual. `asistio1` tiene que quedar 4a, entre reunion1 y
--     reunion2, y las prioridades tienen que ser las de siempre.
select orden, slug, nombre, prioridad, grupo, equivale, activa
  from public.etapas where cliente_id is null order by orden;

-- ⚠️  Prioridades esperadas, sin una sola diferencia:
--     nuevo 110 · programando 100 · reunion1 90 · reunion2 80 ·
--     presentacion 70 · decidiendo 60 · no_respondio 50 · no_asistio 40 ·
--     no_califica 30 · compro 20 · no_compro 10 · asistio1 120 (la nueva)


-- b — Que la traduccion desde GHL no se haya movido ni un milimetro.
--     Son las mismas 14 de la prueba 1 del 006.
select t.entra,
       public.etapa_desde_ghl(t.entra) as sale,
       t.espero,
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

-- ⚠️  Las 14 en ✅.


-- c — Que ningun lead se haya movido de etapa. Esta migracion no toca `leads`.
select etapa_portal, count(*) from public.leads group by 1 order by 2 desc;


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- `etapa_borrar` muda los leads que esten en la etapa borrada a la que se le
-- indique, asi que ninguno queda huerfano. Aca van a `reunion1`, que es de
-- donde habrian salido.
-- ════════════════════════════════════════════════════════════════════════════
/*
do $$
declare v_agencia uuid;
begin
  select user_id into v_agencia
    from public.perfiles where rol='agencia' order by user_id limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_agencia, 'role','authenticated')::text, true);

  perform public.etapa_borrar(null, 'asistio1', 'reunion1');

  perform public.etapas_reordenar(null, array[
    'nuevo','programando','reunion1','reunion2','presentacion','decidiendo',
    'no_respondio','no_asistio','no_califica','compro','no_compro'
  ]);
end $$;
*/
-- ============================================================================
