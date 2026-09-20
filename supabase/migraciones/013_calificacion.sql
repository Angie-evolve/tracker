-- ============================================================================
-- 013_calificacion.sql
--
-- QUE AGREGA
-- La calificacion del lead: alta / media / no califica.
--
-- ES UNA COSA APARTE DE LA ETAPA, no un paso mas del embudo. Un lead puede
-- estar en "Presentación programada" y ser calificacion alta, o estar en la
-- misma etapa y no calificar. Por eso es una columna propia y no una etapa:
-- si fuera una etapa habria que elegir una de las dos cosas y se perderia la
-- otra.
--
-- SOLO SE PUEDE CALIFICAR SI YA PASO LA PRIMERA REUNION. Antes de la reunion
-- no hay con que calificar: lo que se sabe del lead es lo que dijo un
-- formulario.
--
-- ⚠️  "YA PASO LA PRIMERA REUNION" NO SE PUEDE DEDUCIR DEL `orden`.
--     El orden es visual, no es una linea de tiempo. Las etapas frenadas
--     viven al final:
--         asistio1      orden  40   la reunion paso
--         no_respondio  orden  80   nunca llego a la reunion
--         no_asistio    orden  90   la reunion NO paso
--     Un `orden >= 40` dejaria calificar a alguien que no aparecio. Por eso
--     es una columna propia de `etapas`, que dice explicitamente lo que pasa
--     en esa etapa, y no una cuenta sobre el orden.
--
--     Ademas asi sirve para los clientes que se armen etapas propias: marcan
--     la suya y listo, sin tocar ninguna funcion.
--
-- TODO ES ADITIVO. Cuatro columnas nuevas y una funcion nueva.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — La marca en las etapas
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.etapas
  add column if not exists reunion1_hecha boolean not null default false;

comment on column public.etapas.reunion1_hecha is
  'true si estar en esta etapa significa que la primera reunion ya ocurrio. '
  'No se deduce del orden: las etapas frenadas van al final y no_asistio '
  'quedaria adentro.';

-- Las que significan que la reunion ocurrio. `no_asistio` y `no_respondio`
-- quedan afuera a proposito: son justamente las dos en las que no ocurrio.
-- `no_califica` tambien queda afuera: se puede descartar a alguien antes de
-- la reunion, y ademas calificar a un lead que ya esta en "No calificado"
-- seria decir dos veces lo mismo.
update public.etapas set reunion1_hecha = true
 where cliente_id is null
   and slug in ('asistio1','reunion2','presentacion','decidiendo',
                'compro','no_compro');

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Las columnas del lead
--
-- `no_califica` como VALOR de calificacion no es lo mismo que la ETAPA
-- `no_califica`. La etapa dice donde esta el lead en el embudo; la
-- calificacion dice cuanto vale. Se puede tener calificacion 'no_califica' y
-- seguir en "Tomando decisión": significa "sigue andando pero no nos sirve".
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists calificacion text
    check (calificacion in ('alta','media','no_califica'));

alter table public.leads
  add column if not exists calificacion_at  timestamptz;

alter table public.leads
  add column if not exists calificacion_por uuid
    references auth.users(id) on delete set null;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — `lead_calificar`
--
-- Las guardas son LAS MISMAS que las de `lead_etapa` y `lead_datos`, palabra
-- por palabra y en el mismo orden. No es copiar y pegar por pereza: que las
-- tres digan exactamente lo mismo es lo que hace que se puedan revisar juntas.
--
-- El mensaje de "no existe" es el mismo para un lead que no existe y para uno
-- ajeno, a proposito: si dijera "ese lead no es tuyo", un cliente podria
-- averiguar los ids de los leads de otro probando de a uno.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_calificar(
  p_lead_id uuid,
  p_calificacion text default null,   -- null = borrar la calificacion
  p_borrar boolean default false)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_lead_cli   text;
  v_es_agencia boolean;
  v_cliente    text;
  v_etapa      text;
  v_paso       boolean;
begin
  v_es_agencia := public.es_agencia();          -- nunca NULL
  v_cliente    := public.mi_cliente();

  select cliente_id, etapa_portal into v_lead_cli, v_etapa
    from public.leads where id = p_lead_id;

  if v_lead_cli is null then
    raise exception 'Ese lead no existe';
  end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli is distinct from v_cliente) then
    raise exception 'Ese lead no existe';
  end if;

  -- Borrar siempre se puede. Si hubiera que estar tras la reunion para
  -- borrar, un lead calificado por error y despues movido para atras se
  -- quedaria con la calificacion vieja y sin forma de sacarla.
  if p_borrar then
    update public.leads
       set calificacion = null, calificacion_at = now(), calificacion_por = auth.uid()
     where id = p_lead_id;
    return;
  end if;

  if p_calificacion is null
     or p_calificacion not in ('alta','media','no_califica') then
    raise exception 'Calificacion invalida: % (alta / media / no_califica)',
      coalesce(p_calificacion, '(null)');
  end if;

  select e.reunion1_hecha into v_paso
    from public.etapas_de(v_lead_cli) e
   where e.slug = v_etapa;

  -- `coalesce` porque si la etapa del lead no esta en la lista de etapas, el
  -- select no devuelve fila y v_paso queda NULL. Un `if not NULL` no entra,
  -- y el guarda dejaria pasar sin que nadie se entere. Es el mismo error que
  -- tenia `mi_rol() <> 'agencia'` antes del 006.
  if not coalesce(v_paso, false) then
    raise exception 'Todavia no se puede calificar: primero tiene que pasar la primera reunion';
  end if;

  update public.leads
     set calificacion     = p_calificacion,
         calificacion_at  = now(),
         calificacion_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_calificar(uuid, text, boolean) from public, anon;
grant  execute on function public.lead_calificar(uuid, text, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Que etapas dejan calificar. Tienen que ser SEIS, y no_asistio y
--     no_respondio NO pueden estar entre ellas.
select orden, slug, nombre, reunion1_hecha
  from public.etapas where cliente_id is null order by orden;


-- b — Las columnas nuevas.
select column_name, data_type
  from information_schema.columns
 where table_schema='public' and table_name='leads'
   and column_name like 'calificacion%' order by column_name;


-- c — Nadie de afuera llega a la funcion.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute')          as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='lead_calificar';

-- ⚠️  anon_puede = false.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop function if exists public.lead_calificar(uuid, text, boolean);
  alter table public.leads drop column if exists calificacion_por;
  alter table public.leads drop column if exists calificacion_at;
  alter table public.leads drop column if exists calificacion;
  alter table public.etapas drop column if exists reunion1_hecha;
commit;
*/
-- ============================================================================
