-- ============================================================================
-- 006_pruebas.sql   —   NO ES UNA MIGRACION. No se commitea como `migraciones/`.
--
-- Se corre DESPUES del 006. Cada prueba vive dentro de su propia transaccion
-- y termina en `rollback`: no deja ni un dato, ni un cambio.
--
-- Son 6 pruebas. Las 4 primeras tienen que dar bien antes de tocar el portal.
--
-- ----------------------------------------------------------------------------
-- ANTES DE EMPEZAR: el editor SQL de Supabase corre como `postgres` y SIN
-- token, asi que `mi_rol()` da NULL y `es_agencia()` da false. Eso esta bien
-- -es el arreglo funcionando- pero las pruebas 2 y 5 llaman a funciones que
-- exigen ser agencia, y si no te hacés pasar por una cuenta de agencia te van
-- a contestar "Solo la agencia puede...".
--
-- Por eso las dos arrancan seteando el token de una cuenta real. El uuid sale
-- de:   select id, email from auth.users;
-- ----------------------------------------------------------------------------
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 1 — La traduccion de GHL hace lo que decimos
--            `sale` tiene que coincidir con `espero` en las 14 filas.
-- ════════════════════════════════════════════════════════════════════════════

select t.entra,
       public.etapa_desde_ghl(t.entra) as sale,
       t.espero,
       case when public.etapa_desde_ghl(t.entra) is not distinct from t.espero
            then '✅' else '❌' end as ok
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

-- ⚠️  Las 14 tienen que decir ✅. Si alguna da ❌, la `prioridad` esta mal.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 2 — Reordenar NO cambia la traduccion
--            Da vuelta el orden visual entero y vuelve a traducir.
--            Este es el bug que `orden` y `prioridad` separados evitan.
-- ════════════════════════════════════════════════════════════════════════════

begin;

  -- Sin esto, etapas_reordenar contesta "Solo la agencia puede reordenar
  -- etapas": el editor corre sin token y es_agencia() da false.
  select set_config('request.jwt.claims',
    '{"sub":"156437c8-e467-40b9-899f-4ba5ec9b6ef5","role":"authenticated"}', true);

  select public.etapas_reordenar(null, array(
    select slug from public.etapas where cliente_id is null order by orden desc
  ));

  select t.entra,
         public.etapa_desde_ghl(t.entra) as sale_reordenado,
         t.espero,
         case when public.etapa_desde_ghl(t.entra) is not distinct from t.espero
              then '✅' else '❌ SE PISAN' end as ok
  from (values
    ('Primera llamada programada','reunion1'), ('Llamada Agendada','reunion1'),
    ('Nuevo Lead','nuevo'),                    ('No Calificado','no_califica'),
    ('No compró','no_compro'),                 ('Tomando Decisión','decidiendo'),
    ('Respondió','programando'),               ('No respondió','no_respondio')
  ) as t(entra, espero);

rollback;

-- ⚠️  Las 8 tienen que decir ✅, iguales a la prueba 1.
--     Si alguna cambia, `orden` y `prioridad` se estan pisando.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 3 — ⭐ LA IMPORTANTE: un usuario SIN PERFIL no puede nada
--
-- Este es el bug que casi se aplica. Un usuario sin fila en `perfiles` da
-- `mi_rol() = NULL`, y `NULL <> 'agencia'` NO es true: es NULL. Un `if` con
-- NULL adentro no entra, asi que el `raise` nunca disparaba y el guarda
-- dejaba pasar a cualquiera.
--
-- Esta prueba simula exactamente ese usuario. No alcanza con leer el codigo:
-- el codigo viejo SE LEIA BIEN.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create temp table _r(paso text, resultado text);

do $$
declare
  v_lead   uuid;
  -- Los resultados se juntan en variables y se escriben al final, DESPUES de
  -- volver a postgres. La tabla temporal la crea postgres; si escribieramos
  -- mientras somos `authenticated` la primera insercion muere por permisos y
  -- no se ve ni un resultado.
  v_rol    text;
  v_esag   text;
  v_crear  text;
  v_borrar text;
  v_reord  text;
  v_lead_r text;
begin
  -- El lead se busca ANTES de cambiar de rol: como postgres se ve la tabla
  -- entera, asi que la prueba usa un lead que de verdad existe.
  select id into v_lead from public.leads limit 1;

  -- Un usuario logueado que NO tiene fila en `perfiles`.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

  v_rol  := coalesce(public.mi_rol(), '(NULL)  ← el rol es desconocido');
  v_esag := public.es_agencia()::text || '   ← tiene que decir false, NUNCA null';

  -- 3.a — crear una etapa
  begin
    perform public.etapa_crear(null, 'hackeada', 'Hackeada', 'open');
    v_crear := '❌ FALLA: dejo pasar a un usuario sin perfil';
  exception when others then
    v_crear := '✅ freno -> ' || sqlerrm;
  end;

  -- 3.b — borrar una etapa
  begin
    perform public.etapa_borrar(null, 'reunion2', 'reunion1');
    v_borrar := '❌ FALLA: dejo pasar a un usuario sin perfil';
  exception when others then
    v_borrar := '✅ freno -> ' || sqlerrm;
  end;

  -- 3.c — reordenar
  begin
    perform public.etapas_reordenar(null, array['compro','nuevo']);
    v_reord := '❌ FALLA: dejo pasar a un usuario sin perfil';
  exception when others then
    v_reord := '✅ freno -> ' || sqlerrm;
  end;

  -- 3.d — mover un lead ajeno. Es la peor: sin el arreglo, un usuario sin
  --       perfil movia CUALQUIER lead de CUALQUIER cliente.
  if v_lead is null then
    v_lead_r := '⚠️  sin leads en la tabla, no se pudo probar (volver a correr cuando haya)';
  else
    begin
      perform public.lead_etapa(v_lead, 'compro');
      v_lead_r := '❌ FALLA: movio un lead ajeno';
    exception when others then
      v_lead_r := '✅ freno -> ' || sqlerrm;
    end;
  end if;

  -- Vuelta a postgres, y recien ahora se escribe.
  perform set_config('role', 'postgres', true);
  insert into _r values
    ('mi_rol()',         v_rol),
    ('es_agencia()',     v_esag),
    ('etapa_crear',      v_crear),
    ('etapa_borrar',     v_borrar),
    ('etapas_reordenar', v_reord),
    ('lead_etapa',       v_lead_r);
end $$;

select * from _r;

rollback;

-- ⚠️  Las cuatro tienen que decir ✅, y `es_agencia()` tiene que decir `false`.
--     Si alguna dice ❌, NO sigas: el guarda esta abierto.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 4 — Un cliente no puede leer las etapas de otro
--            (`etapas_de` es security definer: bypasea RLS)
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Un perfil de cliente de mentira, con un cliente_id que existe.
create temp table _c as
  select id::text as cli from public.clientes order by id limit 2;

do $$
declare v_yo text; v_otro text; n_yo int; n_otro int; v_uid uuid;
begin
  select cli into v_yo   from _c limit 1;
  select cli into v_otro from _c offset 1 limit 1;

  if v_otro is null then
    raise notice 'Hacen falta 2 clientes para esta prueba';
    return;
  end if;

  -- Le damos etapas propias a cada uno, para que se noten distintas.
  -- etapa_crear exige ser agencia, asi que primero nos hacemos pasar por una.
  perform set_config('request.jwt.claims',
    '{"sub":"156437c8-e467-40b9-899f-4ba5ec9b6ef5","role":"authenticated"}', true);
  perform public.etapa_crear(v_yo,   'mia',  'Etapa mia',  'open');
  perform public.etapa_crear(v_otro, 'suya', 'Etapa suya', 'open');

  -- Ahora nos hacemos pasar por el cliente v_yo.
  --
  -- El uuid tiene que ser de una cuenta REAL: perfiles.user_id apunta a
  -- auth.users, asi que uno inventado rebota por clave foranea. Se le cambia
  -- el rol a una cuenta que ya existe y el rollback se lo devuelve.
  select id into v_uid from auth.users order by created_at limit 1;
  if v_uid is null then
    raise notice 'No hay ninguna cuenta en auth.users para esta prueba';
    return;
  end if;

  update public.perfiles set rol='cliente', cliente_id=v_yo where user_id=v_uid;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  select count(*) into n_yo   from public.etapas_de(v_yo);
  select count(*) into n_otro from public.etapas_de(v_otro);   -- pide las ajenas

  raise notice 'pidiendo las MIAS    -> % etapas', n_yo;
  raise notice 'pidiendo las AJENAS  -> % etapas  (tiene que ser IGUAL: le devolvimos las suyas)', n_otro;

  if exists (select 1 from public.etapas_de(v_otro) where slug = 'suya') then
    raise notice '❌ FALLA: leyo la etapa del otro cliente';
  else
    raise notice '✅ OK: pidio las ajenas y recibio las propias';
  end if;
end $$;

rollback;

-- ⚠️  Tiene que decir ✅. Este se mira en la pestaña de mensajes/notices.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 5 — Borrar una etapa muda los leads en vez de romper
-- ════════════════════════════════════════════════════════════════════════════

begin;

  insert into public.leads (cliente_id, ghl_id, nombre, etapa_portal)
  values ('TEST_006', 'test-006-1', 'Prueba borrar', 'reunion2')
  on conflict do nothing;

  -- Igual que en la 2: etapa_borrar exige ser agencia.
  select set_config('request.jwt.claims',
    '{"sub":"156437c8-e467-40b9-899f-4ba5ec9b6ef5","role":"authenticated"}', true);

  select public.etapa_borrar(null, 'reunion2', 'reunion1') as leads_mudados;

  select etapa_portal as deberia_decir_reunion1,
         case when etapa_portal = 'reunion1' then '✅' else '❌' end as ok
    from public.leads where cliente_id = 'TEST_006';

  select count(*) as etapas_reunion2_deberia_ser_0
    from public.etapas where cliente_id is null and slug = 'reunion2';

rollback;

-- ⚠️  `leads_mudados` = 1, la etapa del lead = 'reunion1', y la borrada = 0.
--     El rollback deja todo como estaba: el lead de prueba NO queda.
--
--     NOTA: si `leads` tiene columnas NOT NULL que este insert no llena,
--     ajustalo. El insert es lo de menos; lo que se prueba es la mudanza.


-- ════════════════════════════════════════════════════════════════════════════
-- PRUEBA 6 — Estructura y permisos
-- ════════════════════════════════════════════════════════════════════════════

-- 6.a — La plantilla quedo completa: 11 filas.
select slug, nombre, grupo, equivale, orden, prioridad, pide_monto, activa,
       array_length(ghl_patrones, 1) as n_patrones
  from public.etapas
 where cliente_id is null
 order by orden;

-- 6.b — Nadie de afuera llega a las funciones nuevas.
select p.proname,
       pg_get_function_identity_arguments(p.oid)              as args,
       p.prosecdef                                            as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('es_agencia','lead_etapa','etapa_desde_ghl','etapas_de',
                     'etapa_crear','etapa_borrar','etapas_reordenar',
                     'etapa_sin_leads','lead_marcar')
 order by p.proname;

-- ⚠️  `anon_puede` = false en TODAS.
-- ⚠️  `lead_etapa` tiene que decir `p_lead_id uuid`. Si dice bigint, quedo la
--     version vieja dando vueltas: dropeala a mano.

-- 6.c — Las 45 variantes reales de GHL, y cuales no se pudieron traducir.
select
  op->>'pipelineStage'  as stage_ghl,
  count(*)              as n,
  coalesce(public.etapa_desde_ghl(op->>'pipelineStage'), '❌ SIN TRADUCIR') as etapa
from public.clientes c,
     lateral jsonb_array_elements(
       coalesce(c.datos->'ghl'->'opportunities', '[]'::jsonb)
     ) as op
group by 1, 3
order by n desc;

-- ⚠️  Lo que diga "❌ SIN TRADUCIR" con volumen alto se arregla con un UPDATE
--     al array `ghl_patrones` de la etapa que corresponda (esta al final del
--     006). Lo que tenga 1 o 2 leads puede quedar sin traducir: cae en 'nuevo'.
-- ============================================================================
