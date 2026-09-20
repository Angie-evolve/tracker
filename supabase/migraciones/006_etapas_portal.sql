-- ============================================================================
-- 006_etapas_portal.sql
--
-- QUE ARREGLA
-- El 005 modelo el estado del lead con los 4 valores de GHL
-- (open / won / lost / abandoned). El embudo comercial real tiene ~11 etapas,
-- y cada cliente tiene que poder ajustarlas, reordenarlas y borrarlas.
--
-- DECISION DE FONDO: las etapas son DATOS, no codigo.
-- Van en una tabla, no en un CHECK. Un CHECK es una lista fija; nosotros
-- queremos una lista que cambie sin migracion. La tabla `etapas` es la unica
-- fuente de verdad: nombre, color, orden, grupo, a que equivale en GHL, y que
-- textos de GHL caen ahi.
--
-- POR QUE UNA COLUMNA NUEVA EN `leads` Y NO AMPLIAR `estado`:
-- `estado` la escribe el sync de GHL. Si el cliente escribiera ahi, el proximo
-- sync le pasaria por arriba y le borraria lo que marco, sin ningun error
-- visible. Cada columna tiene un unico dueño:
--     estado        -> lo escribe el sync   (4 valores de GHL, no se muestra)
--     etapa         -> lo escribe el sync   (texto crudo, las 45 variantes)
--     etapa_portal  -> lo escribe el CLIENTE (el slug de la etapa, es lo que se ve)
--
-- TODO ES ADITIVO. No hay drop, ni rename, ni cambio de tipo.
-- Se corre con `leads` en 0 filas, asi que no hay backfill que pueda salir mal.
--
-- Son 7 partes. La parte 6 es un FRENO: no sigas sin mirarla.
--
-- ⚠️  REVISION PENDIENTE — NO CORRER TODAVIA. Ver los tres puntos al final
--     del archivo, en "REVISION 20/09".
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — La tabla de etapas
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.etapas (
  id           bigint generated always as identity primary key,
  cliente_id   text,
  slug         text not null,
  nombre       text not null,
  grupo        text not null check (grupo in ('nuevo','avanzando','frenado','cerrado')),
  equivale     text not null default 'open'
               check (equivale in ('open','won','lost','abandoned')),
  orden        int  not null default 0,
  prioridad    int  not null default 500,
  color        text,
  pide_monto   boolean not null default false,
  activa       boolean not null default true,
  ghl_patrones text[] not null default '{}',
  creada_at    timestamptz not null default now()
);

create unique index if not exists etapas_cli_slug
  on public.etapas (cliente_id, slug) where cliente_id is not null;
create unique index if not exists etapas_def_slug
  on public.etapas (slug)             where cliente_id is null;

create index if not exists etapas_lista
  on public.etapas (cliente_id, activa, orden);

alter table public.etapas enable row level security;
revoke all on public.etapas from anon;

drop policy if exists "agencia_etapas" on public.etapas;
create policy "agencia_etapas" on public.etapas
  for all to authenticated
  using      (public.mi_rol() = 'agencia')
  with check (public.mi_rol() = 'agencia');

drop policy if exists "cliente_etapas_ve" on public.etapas;
create policy "cliente_etapas_ve" on public.etapas
  for select to authenticated
  using (
    public.mi_rol() = 'cliente'
    and (cliente_id is null or cliente_id = public.mi_cliente())
  );

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Las columnas nuevas en `leads`
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists etapa_portal text not null default 'nuevo';

alter table public.leads
  add column if not exists monto numeric;

alter table public.leads
  add column if not exists etapa_at  timestamptz;
alter table public.leads
  add column if not exists etapa_por uuid references auth.users(id);

create index if not exists leads_cliente_etapa_idx
  on public.leads (cliente_id, etapa_portal);

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — La plantilla por defecto: las 11 etapas
-- ════════════════════════════════════════════════════════════════════════════

insert into public.etapas
  (cliente_id, slug, nombre, grupo, equivale, orden, prioridad, color, pide_monto, ghl_patrones)
values
  (null, 'nuevo',        'Nuevo lead',                      'nuevo',     'open',      10, 110, '#c9c9c9', false,
   array['nuevo','new lead']),
  (null, 'programando',  'Programando primera reunión',     'avanzando', 'open',      20, 100, '#6ba8e0', false,
   array['respondi','contacto','contactad','interesad']),
  (null, 'reunion1',     'Primera reunión programada',      'avanzando', 'open',      30,  90, '#6ba8e0', false,
   array['primera','1ra','1era','agendad','programad','reunion','llamada','meeting']),
  (null, 'reunion2',     'Segunda reunión programada',      'avanzando', 'open',      40,  80, '#6ba8e0', false,
   array['segunda','2da','2a ','seguimiento']),
  (null, 'presentacion', 'Presentación programada',         'avanzando', 'open',      50,  70, '#6ba8e0', false,
   array['presentaci','propuesta']),
  (null, 'decidiendo',   'Tomando decisión',                'avanzando', 'open',      60,  60, '#6ba8e0', false,
   array['decisi','desicion','desici','evaluando']),
  (null, 'no_respondio', 'No respondió',                    'frenado',   'abandoned', 70,  50, '#e0a458', false,
   array['no respondi','no contesto','sin respuesta']),
  (null, 'no_asistio',   'No asistió a la primera reunión', 'frenado',   'abandoned', 80,  40, '#e0a458', false,
   array['no asisti','no se presento','no show']),
  (null, 'no_califica',  'No calificado',                   'frenado',   'lost',      90,  30, '#8a8a8a', false,
   array['no califica','no calificad','descartad']),
  (null, 'compro',       'Compró',                          'cerrado',   'won',      100,  20, '#4ecfa0', true,
   array['compro','ganad','cliente nuevo','cerrad%gan']),
  (null, 'no_compro',    'No compró',                       'cerrado',   'lost',     110,  10, '#8a8a8a', false,
   array['no compro','perdid'])
on conflict do nothing;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — Alta, baja, reordenar
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.etapa_crear(
  p_cliente   text,
  p_slug      text,
  p_nombre    text,
  p_equivale  text,
  p_grupo     text    default null,
  p_color     text    default null,
  p_patrones  text[]  default '{}'
)
returns public.etapas
language plpgsql security definer set search_path = public
as $$
declare v_grupo text; v_ord int; v_pri int; v_fila public.etapas;
begin
  if public.mi_rol() <> 'agencia' then
    raise exception 'Solo la agencia puede crear etapas';
  end if;
  if p_equivale not in ('open','won','lost','abandoned') then
    raise exception 'Equivale invalido: % (open / won / lost / abandoned)', p_equivale;
  end if;

  v_grupo := coalesce(p_grupo, case p_equivale
    when 'won'       then 'cerrado'
    when 'lost'      then 'cerrado'
    when 'abandoned' then 'frenado'
    else                  'avanzando'
  end);

  select coalesce(max(orden),     0) + 10,
         coalesce(max(prioridad), 0) + 10
    into v_ord, v_pri
    from public.etapas
   where cliente_id is not distinct from p_cliente;

  insert into public.etapas
    (cliente_id, slug, nombre, grupo, equivale, orden, prioridad, color, pide_monto, ghl_patrones)
  values
    (p_cliente, p_slug, p_nombre, v_grupo, p_equivale, v_ord, v_pri, p_color,
     p_equivale = 'won', p_patrones)
  returning * into v_fila;

  return v_fila;
end $$;


create or replace function public.etapa_borrar(
  p_cliente  text,
  p_slug     text,
  p_destino  text
)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if public.mi_rol() <> 'agencia' then
    raise exception 'Solo la agencia puede borrar etapas';
  end if;
  if p_slug = p_destino then
    raise exception 'El destino tiene que ser una etapa distinta';
  end if;

  perform 1 from public.etapas_de(p_cliente) where slug = p_destino and activa;
  if not found then
    raise exception 'La etapa destino "%" no existe o esta archivada', p_destino;
  end if;

  update public.leads
     set etapa_portal = p_destino,
         etapa_at     = now(),
         etapa_por    = auth.uid()
   where etapa_portal = p_slug
     and (p_cliente is null or cliente_id = p_cliente);
  get diagnostics n = row_count;

  delete from public.etapas
   where slug = p_slug
     and cliente_id is not distinct from p_cliente;

  return n;
end $$;


create or replace function public.etapas_reordenar(
  p_cliente text,
  p_slugs   text[]
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if public.mi_rol() <> 'agencia' then
    raise exception 'Solo la agencia puede reordenar etapas';
  end if;

  update public.etapas e
     set orden = pos.i * 10
    from unnest(p_slugs) with ordinality as pos(s, i)
   where e.slug = pos.s
     and e.cliente_id is not distinct from p_cliente;
end $$;


create or replace function public.etapa_sin_leads()
returns trigger language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  select count(*) into n
    from public.leads
   where etapa_portal = old.slug
     and (old.cliente_id is null or cliente_id = old.cliente_id);

  if n > 0 then
    raise exception
      'No se puede borrar "%": hay % lead(s) ahi. Usá etapa_borrar(%L, %L, ''<etapa destino>'') para mudarlos primero.',
      old.nombre, n, old.cliente_id, old.slug;
  end if;
  return old;
end $$;

drop trigger if exists etapas_no_borrar_con_leads on public.etapas;
create trigger etapas_no_borrar_con_leads
  before delete on public.etapas
  for each row execute function public.etapa_sin_leads();


revoke all     on function public.etapa_crear(text,text,text,text,text,text,text[]) from public, anon;
revoke all     on function public.etapa_borrar(text,text,text)                      from public, anon;
revoke all     on function public.etapas_reordenar(text,text[])                     from public, anon;
grant  execute on function public.etapa_crear(text,text,text,text,text,text,text[]) to authenticated;
grant  execute on function public.etapa_borrar(text,text,text)                      to authenticated;
grant  execute on function public.etapas_reordenar(text,text[])                     to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — Leer etapas, traducir de GHL, y mover un lead
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.etapas_de(p_cliente text)
returns setof public.etapas
language sql stable security definer set search_path = public
as $$
  select * from public.etapas
   where cliente_id = p_cliente
   union all
  select * from public.etapas
   where cliente_id is null
     and not exists (select 1 from public.etapas where cliente_id = p_cliente)
   order by orden
$$;

revoke all     on function public.etapas_de(text) from anon;
grant  execute on function public.etapas_de(text) to authenticated;


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
        return r.slug;
      end if;
    end loop;
  end loop;

  return null;
end $$;

revoke all     on function public.etapa_desde_ghl(text, text) from anon;
grant  execute on function public.etapa_desde_ghl(text, text) to authenticated;


create or replace function public.lead_etapa(
  p_lead_id bigint,
  p_etapa   text,
  p_monto   numeric default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_cliente text; v_es_agencia boolean; v_lead_cli text; v_pide boolean;
begin
  v_es_agencia := (public.mi_rol() = 'agencia');
  v_cliente    := public.mi_cliente();

  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;

  if v_lead_cli is null then raise exception 'Ese lead no existe'; end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli <> v_cliente) then
    raise exception 'Ese lead no existe';
  end if;

  select pide_monto into v_pide
    from public.etapas_de(v_lead_cli)
   where slug = p_etapa and activa;

  if not found then
    raise exception 'Etapa invalida: %', p_etapa;
  end if;

  update public.leads
     set etapa_portal = p_etapa,
         monto        = case when v_pide then coalesce(p_monto, monto) else monto end,
         etapa_at     = now(),
         etapa_por    = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_etapa(bigint, text, numeric) from public, anon;
grant  execute on function public.lead_etapa(bigint, text, numeric) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 6 — FRENO. Correr esto y mirarlo con los ojos.
-- (las consultas van en el mensaje original; se corren a mano una por una)
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 7 — Como volver atras
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop trigger  if exists etapas_no_borrar_con_leads on public.etapas;
  drop function if exists public.etapa_sin_leads();
  drop function if exists public.etapas_reordenar(text,text[]);
  drop function if exists public.etapa_borrar(text,text,text);
  drop function if exists public.etapa_crear(text,text,text,text,text,text,text[]);
  drop function if exists public.lead_etapa(bigint, text, numeric);
  drop function if exists public.etapa_desde_ghl(text, text);
  drop function if exists public.etapas_de(text);
  drop table    if exists public.etapas;
  drop index    if exists public.leads_cliente_etapa_idx;
  alter table public.leads drop column if exists etapa_por;
  alter table public.leads drop column if exists etapa_at;
  alter table public.leads drop column if exists monto;
  alter table public.leads drop column if exists etapa_portal;
commit;
*/


-- ════════════════════════════════════════════════════════════════════════════
-- REVISION 20/09 — TRES COSAS ANTES DE CORRER ESTO
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. lead_etapa(p_lead_id BIGINT) pero leads.id es UUID.
--    Verificado contra la base: information_schema dice uuid. La funcion se
--    crea sin chistar -plpgsql no valida el cuerpo- y revienta la primera vez
--    que alguien la llama. Va con uuid en los tres lugares: el parametro, el
--    revoke y el grant.
--
-- 2. LOS GUARDAS SE ABREN SOLOS SI mi_rol() ES NULL.
--    Un usuario sin perfil da mi_rol() = NULL. Y en SQL:
--        NULL <> 'agencia'  ->  NULL  ->  el IF no entra  ->  NO frena
--    Verificado en la base. Afecta a etapa_crear, etapa_borrar y
--    etapas_reordenar. En lead_etapa es peor:
--        v_es_agencia := (mi_rol() = 'agencia')   -> NULL
--        if not v_es_agencia and (...)            -> NULL -> no entra
--    o sea que un usuario sin perfil movería CUALQUIER lead de CUALQUIER
--    cliente. Hoy no hay cuentas sin perfil -el trigger del 001 le crea uno a
--    toda cuenta nueva- pero el guarda no puede depender de eso.
--    Se cierra con: if coalesce(public.mi_rol(),'') <> 'agencia' then
--    y en lead_etapa: v_es_agencia := (coalesce(public.mi_rol(),'') = 'agencia');
--
-- 3. etapas_de() y etapa_desde_ghl() son security definer y las puede ejecutar
--    cualquier authenticated, sin mirar de quien es p_cliente. Un cliente
--    puede pedir etapas_de('<id de otro cliente>') y leer las etapas de la
--    competencia. Se cierra chequeando adentro: si mi_rol() = 'cliente',
--    p_cliente tiene que ser mi_cliente().
--
-- (la firma real del 005 es lead_marcar(uuid, text, numeric, text), para el
--  revoke del PENDIENTE de mas abajo)
