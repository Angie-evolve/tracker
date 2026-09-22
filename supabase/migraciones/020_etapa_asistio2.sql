-- ============================================================================
-- 020_etapa_asistio2.sql
--
-- QUE AGREGA
-- La etapa "Asistió a la segunda reunión", entre "Segunda reunión programada"
-- y "Presentación programada".
--
-- Es la hermana de `asistio1`, que agrego el `011` por la misma razon: sin
-- ella, un lead que fue a la segunda reunion y uno que todavia no llego a la
-- segunda reunion quedan los dos en "Segunda reunión programada" y de afuera
-- no se distinguen.
--
-- POR QUE AHORA. Hasta hoy el portal tenia una columna "Asistió" aparte, que
-- no se guardaba: se leia de la etapa (`reunion1_hecha`). Esa columna se saca,
-- y con ella la unica forma de ver la asistencia. Asi que la asistencia pasa a
-- vivir donde ya vivia de verdad —la etapa— pero ahora tambien para la
-- segunda reunion, que antes no tenia como decirse.
--
-- ⚠️  "REUNIÓN" Y NO "LLAMADA". Las otras cuatro filas del embudo dicen
--     reunion: "Primera reunión programada", "Segunda reunión programada",
--     "No asistió a la primera reunión", "Asistió a la primera reunión".
--     Mezclar las dos palabras en la misma lista deja a alguien preguntandose
--     si son dos cosas distintas. Si preferis "llamada", se cambia el nombre
--     de las cinco juntas, no el de una.
--
-- ⚠️  SIN PATRONES DE GHL, por lo mismo que el `011`: GHL sabe que la reunion
--     se agendo, no sabe si la persona aparecio. Eso lo sabe quien estuvo.
--     Ademas no ganaria: `etapa_desde_ghl` recorre por `prioridad` ASCENDENTE
--     y devuelve la primera que matchea, y esta —por venir de `etapa_crear`—
--     nace con la prioridad mas alta de todas, asi que se evalua ultima.
--
-- TODO ES ADITIVO. Una fila nueva, un renumerado de `orden`, y un color.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- COMO CORRERLO
--
-- Igual que el `011`: `etapa_crear` y `etapas_reordenar` exigen `es_agencia()`,
-- que lee el perfil de `auth.uid()`. El editor SQL corre como `postgres` y sin
-- JWT, asi que `auth.uid()` es NULL y las dos cortarian con "Solo la agencia
-- puede...". Por eso todo va adentro de UN bloque que primero se hace pasar
-- por una cuenta de agencia que ya existe —el user_id se busca solo, no se
-- escribe ninguno aca— y es un bloque unico porque `set_config(..., true)`
-- dura lo que dura la transaccion.
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
  v_fila := public.etapa_crear(
    null,                               -- la plantilla, no un cliente suelto
    'asistio2',
    'Asistió a la segunda reunión',
    'open',
    'avanzando',
    '#6ba8e0',                          -- el azul del resto del grupo
    '{}'::text[]                        -- sin patrones: ver el encabezado
  );
  raise notice 'Creada: slug=% orden=% prioridad=%',
    v_fila.slug, v_fila.orden, v_fila.prioridad;

  -- ── PARTE 2 — `reunion1_hecha` ────────────────────────────────────────
  --
  -- `etapa_crear` no recibe esta bandera, asi que nace en false, y en false
  -- estaria diciendo que la primera reunion NO paso en un lead que ya fue a
  -- la SEGUNDA. Ademas `puedeCalificar` cuelga de esta columna: en false, un
  -- lead en esta etapa no se podria calificar.
  update public.etapas
     set reunion1_hecha = true
   where cliente_id is null and slug = 'asistio2';

  -- El `011` dejo a `asistio1` sin color, y el portal le pinta el punto gris
  -- de "sin color" mientras sus cinco vecinas de "Avanzando" son azules. Con
  -- dos etapas "Asistió a la..." seguidas, una gris y una azul, el color
  -- pasaria a parecer que significa algo. Las empareja.
  update public.etapas
     set color = '#6ba8e0'
   where cliente_id is null and slug = 'asistio1' and color is null;

  -- ── PARTE 3 — ponerla en su lugar ─────────────────────────────────────
  --
  -- ⚠️  ESTO NO TOCA NINGUNA `prioridad`. `etapas_reordenar` hace un
  --     `update ... set orden = pos.i * 10` y nada mas. Las prioridades de
  --     las doce que ya estaban quedan como estaban, y con ellas la
  --     traduccion desde GHL. La prueba `b` de abajo lo comprueba.
  perform public.etapas_reordenar(null, array[
    'nuevo',
    'programando',
    'reunion1',
    'asistio1',
    'reunion2',
    'asistio2',        -- ← entra acá
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
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — El orden visual: `asistio2` 6a, entre reunion2 y presentacion. Y las
--     prioridades, sin una sola diferencia.
select orden, slug, nombre, prioridad, reunion1_hecha, color, activa
  from public.etapas where cliente_id is null order by orden;

-- ⚠️  Prioridades esperadas: nuevo 110 · programando 100 · reunion1 90 ·
--     asistio1 120 · reunion2 80 · asistio2 130 (la nueva) ·
--     presentacion 70 · decidiendo 60 · no_respondio 50 · no_asistio 40 ·
--     no_califica 30 · compro 20 · no_compro 10.


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

-- ⚠️  Las 14 en ✅. Y ninguna cae en `asistio2`.


-- c — Que ningun lead se haya movido de etapa. Esta migracion no toca `leads`.
select etapa_portal, count(*) from public.leads group by 1 order by 2 desc;

-- ⚠️  `asistio2` no aparece: nace vacia.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- `etapa_borrar` muda los leads que esten en la etapa borrada a la que se le
-- indique, asi que ninguno queda huerfano. Aca van a `reunion2`, que es de
-- donde habrian salido. El color de `asistio1` vuelve a NULL.
-- ════════════════════════════════════════════════════════════════════════════
/*
do $$
declare v_agencia uuid;
begin
  select user_id into v_agencia
    from public.perfiles where rol='agencia' order by user_id limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_agencia, 'role','authenticated')::text, true);

  perform public.etapa_borrar(null, 'asistio2', 'reunion2');

  update public.etapas set color = null
   where cliente_id is null and slug = 'asistio1';

  perform public.etapas_reordenar(null, array[
    'nuevo','programando','reunion1','asistio1','reunion2','presentacion',
    'decidiendo','no_respondio','no_asistio','no_califica','compro','no_compro'
  ]);
end $$;
*/
-- ============================================================================
