-- ============================================================================
-- 019_oferta_presentada.sql
--
-- QUE ARREGLA
-- El `017` guardo la oferta como UN NUMERO DE REUNION (`presento_en`: 1, 2,
-- 3...). La forma estaba mal, y esta migracion la corrige.
--
-- POR QUE ESTABA MAL
-- En el tracker de ventas que ya usa el equipo, "Oferta presentada" tiene
-- TRES estados —Pendiente / Si / No— y el numero de llamada vive en otra
-- columna, "Stage" (1ra llamada, 2da llamada). Asi que la pregunta original,
-- "¿oferto en la primera o en la segunda?", se contesta CRUZANDO las dos:
-- la etapa dice en que llamada esta, y esta columna dice si hubo oferta.
--
-- Con un numero no se puede decir "NO se presento la oferta". `presento_en`
-- solo distingue "en la reunion N" de "no sabemos": le falta el "no".
-- Y ese es justo el estado que mas se usa para descartar.
--
-- ⚠️  POR QUE UNA COLUMNA NUEVA Y NO REUSAR `presento_en` ENSANCHANDO SU
--     CHECK para aceptar 0 = "no": porque `presento_en = 1` pasaria a
--     significar "si", no "en la primera reunion", y el nombre de la columna
--     diria otra cosa que el dato. Es exactamente el problema que arreglo el
--     `012` con `etapa_at`: una columna que dice una cosa y guarda otra no se
--     nota hasta que alguien construye algo encima.
--
--     `presento_en` queda SIN USO. No se borra: la zona COMPARTIDA solo suma,
--     y un `drop` no tiene vuelta atras. Esta anotada en LIMPIEZA.md como
--     candidata a borrar. Esta vacia: se verifico que los 287 leads la tienen
--     en NULL antes de dejarla de lado.
--
-- TRES ESTADOS CON UN BOOLEAN NULABLE:
--     NULL   -> Pendiente   (todavia no se sabe)
--     true   -> Si          (se presento la oferta)
--     false  -> No          (no se presento)
--
-- TODO ES ADITIVO. Tres columnas y una funcion.
-- ============================================================================

begin;

alter table public.leads
  add column if not exists oferta_presentada boolean;

alter table public.leads
  add column if not exists oferta_at  timestamptz;

alter table public.leads
  add column if not exists oferta_por uuid
    references auth.users(id) on delete set null;

comment on column public.leads.oferta_presentada is
  'NULL = pendiente, true = se presento la oferta, false = no se presento. '
  'En que reunion paso NO se guarda aca: sale de la etapa del lead.';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- La funcion. Guardas iguales a lead_etapa, lead_datos, lead_calificar y
-- lead_presento, palabra por palabra.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_oferta(
  p_lead_id uuid,
  p_oferta boolean default null,     -- true = si, false = no
  p_borrar boolean default false)    -- true = volver a Pendiente
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
  -- pasar NULL en `p_oferta` es indistinguible de no pasar nada.
  if not p_borrar and p_oferta is null then
    raise exception 'Falta decir si la oferta se presento (true o false)';
  end if;

  update public.leads
     set oferta_presentada = case when p_borrar then null else p_oferta end,
         oferta_at  = now(),
         oferta_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_oferta(uuid, boolean, boolean) from public, anon;
grant  execute on function public.lead_oferta(uuid, boolean, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Las columnas nuevas, y que `presento_en` este vacia antes de dejarla.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='leads'
      and column_name in ('oferta_presentada','oferta_at','oferta_por')) as columnas_nuevas,
  (select count(presento_en) from public.leads)                          as presento_en_en_uso,
  (select count(*) from public.leads)                                    as leads;

-- ⚠️  columnas_nuevas = 3, presento_en_en_uso = 0.

-- b — `anon` no la puede ejecutar.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='lead_oferta';

-- c — La pregunta original sigue teniendo respuesta, cruzando con la etapa.
select coalesce(e.nombre, l.etapa_portal) as etapa,
       count(*) filter (where l.oferta_presentada)            as oferto,
       count(*) filter (where l.oferta_presentada = false)    as no_oferto,
       count(*) filter (where l.oferta_presentada is null)    as pendiente
  from public.leads l
  left join public.etapas e
    on e.slug = l.etapa_portal and e.cliente_id is null
 group by 1 order by 1;


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop function if exists public.lead_oferta(uuid, boolean, boolean);
  alter table public.leads drop column if exists oferta_por;
  alter table public.leads drop column if exists oferta_at;
  alter table public.leads drop column if exists oferta_presentada;
commit;
*/
-- ============================================================================
