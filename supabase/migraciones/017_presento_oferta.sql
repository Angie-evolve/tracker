-- ============================================================================
-- 017_presento_oferta.sql
--
-- QUE AGREGA
-- En que reunion se presento la oferta. Un numero: 1 si fue en la primera, 2
-- si fue en la segunda. NULL si todavia no se presento.
--
-- POR QUE NO ALCANZA CON LA ETAPA
-- Hoy la presentacion se DEDUCE de la etapa. El tracker lo dice solo, en
-- index.html:5419: marca el paso como `approx:true` y explica "Como se
-- infiere: Stage actual de presentacion".
--
-- Deducirla de la etapa la ata al embudo, y el embudo tiene un orden:
--   reunion1 -> reunion2 -> presentacion
-- Eso da por sentado que la oferta se presenta DESPUES de la segunda reunion.
-- En la realidad se puede presentar en la primera, y entonces no hay forma de
-- distinguir a quien presento en la primera de quien presento en la segunda:
-- los dos terminan en la misma etapa.
--
-- Es la misma idea que `calificacion` (013): un hecho del lead que no es un
-- paso del embudo y por eso vive en su propia columna.
--
-- ⚠️  NO SE PIDE QUE LA ETAPA "YA PASO LA REUNION", a diferencia de la
--     calificacion. Marcar "presente en la reunion 1" ES la prueba de que esa
--     reunion ocurrio. Pedir ademas que la etapa lo diga volveria a atar las
--     dos cosas, que es justo lo que esto viene a separar, y dejaria sin poder
--     anotar un hecho real a quien no actualizo la etapa todavia.
--
-- ⚠️  LA ETAPA `presentacion` NO SE TOCA. Significa otra cosa: que hay una
--     presentacion AGENDADA. Esta columna dice donde ocurrio. Son dos
--     preguntas distintas y las dos sirven.
--
-- TODO ES ADITIVO. Tres columnas y una funcion.
-- ============================================================================

begin;

-- smallint y no un texto con 'primera'/'segunda': si algun cliente hace tres
-- reuniones antes de presentar, entra sin cambiar nada.
alter table public.leads
  add column if not exists presento_en smallint
    check (presento_en is null or (presento_en >= 1 and presento_en <= 9));

alter table public.leads
  add column if not exists presento_at  timestamptz;

alter table public.leads
  add column if not exists presento_por uuid
    references auth.users(id) on delete set null;

comment on column public.leads.presento_en is
  'En que reunion se presento la oferta (1 = la primera). NULL = todavia no. '
  'Es independiente de la etapa: se puede presentar en la primera reunion y '
  'seguir en cualquier etapa.';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- La funcion. Las guardas son LAS MISMAS que las de `lead_etapa`,
-- `lead_datos` y `lead_calificar`, palabra por palabra: que las cuatro digan
-- lo mismo es lo que permite revisarlas juntas.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_presento(
  p_lead_id uuid,
  p_reunion smallint default null,   -- 1, 2, 3...
  p_borrar boolean default false)
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

  if p_borrar then
    update public.leads
       set presento_en = null, presento_at = now(), presento_por = auth.uid()
     where id = p_lead_id;
    return;
  end if;

  if p_reunion is null or p_reunion < 1 or p_reunion > 9 then
    raise exception 'Reunion invalida: % (tiene que ser un numero del 1 al 9)',
      coalesce(p_reunion::text, '(null)');
  end if;

  update public.leads
     set presento_en  = p_reunion,
         presento_at  = now(),
         presento_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_presento(uuid, smallint, boolean) from public, anon;
grant  execute on function public.lead_presento(uuid, smallint, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Las columnas.
select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='leads'
   and column_name like 'presento%' order by column_name;

-- b — Permisos. `anon_puede` = false.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='lead_presento';

-- c — La pregunta que esto viene a contestar: cuantos presentaron en la
--     primera y cuantos en la segunda.
select coalesce(presento_en::text,'todavia no') as presento_en,
       count(*) as leads
  from public.leads group by 1 order by 1;


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop function if exists public.lead_presento(uuid, smallint, boolean);
  alter table public.leads drop column if exists presento_por;
  alter table public.leads drop column if exists presento_at;
  alter table public.leads drop column if exists presento_en;
commit;
*/
-- ============================================================================
