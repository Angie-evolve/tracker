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
-- sync le pasaria por arriba. Cada columna tiene un unico dueño:
--     estado        -> lo escribe el sync   (4 valores de GHL, no se muestra)
--     etapa         -> lo escribe el sync   (texto crudo, las 45 variantes)
--     etapa_portal  -> lo escribe el CLIENTE (el slug de la etapa, es lo que se ve)
--
-- TODO ES ADITIVO. No hay drop, ni rename, ni cambio de tipo.
-- Se corre con `leads` en 0 filas, asi que no hay backfill que pueda salir mal.
--
-- LAS PRUEBAS VAN APARTE, en `006_pruebas.sql`. Este archivo se corre entero.
--
-- ----------------------------------------------------------------------------
-- CORREGIDO respecto de la version anterior (3 bugs, encontrados antes de
-- aplicar — ninguno llego a la base):
--
--   1. `lead_etapa` tomaba `bigint`. `leads.id` es `uuid`. Postgres crea la
--      funcion igual (plpgsql no valida el cuerpo al crearla) y revienta
--      recien la primera vez que alguien la llama.
--
--   2. Los guardas decian `if public.mi_rol() <> 'agencia' then raise`.
--      Un usuario SIN PERFIL da `mi_rol() = NULL`, y `NULL <> 'agencia'` no
--      es `true`: es NULL. El `if` no entra y el guarda no frena a nadie.
--      Arreglado de raiz con `es_agencia()`, que devuelve boolean y NUNCA
--      NULL. Ningun guarda vuelve a preguntar por el rol directamente.
--
--   3. `etapas_de()` y `etapa_desde_ghl()` son security definer (bypasean RLS)
--      y estaban otorgadas a cualquier `authenticated` sin mirar de quien era
--      `p_cliente`. Un cliente podia leer las etapas de otro. Ahora la funcion
--      ignora el `p_cliente` que le mandan si el que llama no es agencia, y usa
--      el del token.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 0 — El guarda que no puede devolver NULL
--
-- Esta funcion existe para que ningun guarda de aca en adelante tenga que
-- preguntar `mi_rol() <> 'agencia'`. Esa pregunta es la que fallaba: con un
-- rol NULL la respuesta de Postgres es NULL, y un `if` con NULL adentro NO
-- entra, asi que el `raise` nunca disparaba.
--
-- `es_agencia()` devuelve true o false. Nunca NULL. Punto.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.es_agencia()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.mi_rol(), '') = 'agencia' $$;

revoke all     on function public.es_agencia() from public, anon;
grant  execute on function public.es_agencia() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — La tabla de etapas
--
-- cliente_id NULL  = plantilla por defecto (la que arranca todo el mundo)
-- cliente_id 'xxx' = etapas propias de ese cliente
--
-- Regla: si un cliente tiene AL MENOS UNA etapa propia, usa las suyas y la
-- plantilla no se mezcla. Es mas predecible que combinar las dos.
--
-- ⚠️  DOS ORDENES DISTINTOS, Y NO ES REDUNDANCIA:
--     `orden`     -> en que posicion se MUESTRA. Lo mueve el usuario, libre.
--     `prioridad` -> cual patron de GHL gana cuando dos matchean. Interno.
--     Si fueran la misma columna, arrastrar una etapa para que quede mas linda
--     cambiaria a donde van a parar los leads que entran de GHL, sin que nadie
--     se entere.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.etapas (
  id           bigint generated always as identity primary key,
  cliente_id   text,           -- NULL = plantilla por defecto
  slug         text not null,  -- interno, NO se edita nunca. Es lo que guarda el lead.
  nombre       text not null,  -- lo que se ve. Se edita libre.

  -- donde se muestra en el portal (la hoja de abajo agrupa por esto)
  grupo        text not null check (grupo in ('nuevo','avanzando','frenado','cerrado')),

  -- a que equivale para GHL y para las metricas. Es el puente para que el dia
  -- de mañana el portal pueda escribirle de vuelta a GHL.
  equivale     text not null default 'open'
               check (equivale in ('open','won','lost','abandoned')),

  orden        int  not null default 0,    -- lo mueve el usuario
  prioridad    int  not null default 500,  -- interno: precedencia de patrones
  color        text,
  pide_monto   boolean not null default false,
  activa       boolean not null default true,  -- false = archivada
  ghl_patrones text[] not null default '{}',
  creada_at    timestamptz not null default now()
);

-- Unico por cliente, y unico dentro de la plantilla. Van dos indices parciales
-- porque en Postgres NULL nunca es igual a NULL: un UNIQUE comun dejaria meter
-- la plantilla dos veces.
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
  using      (public.es_agencia())
  with check (public.es_agencia());

-- El cliente LEE las suyas y la plantilla. No escribe: si mañana querés que
-- pueda, se agrega una policy aparte. Hoy las configura la agencia.
drop policy if exists "cliente_etapas_ve" on public.etapas;
create policy "cliente_etapas_ve" on public.etapas
  for select to authenticated
  using (
    coalesce(public.mi_rol(), '') = 'cliente'
    and (cliente_id is null or cliente_id = public.mi_cliente())
  );

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Las columnas nuevas en `leads`
--
-- Ojo: `etapa_portal` NO lleva CHECK. No puede: las etapas son datos y cambian.
-- Quien valida es `lead_etapa()` (parte 5), que mira la tabla.
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists etapa_portal text not null default 'nuevo';

alter table public.leads
  add column if not exists monto numeric;

-- Quien movio la etapa y cuando. Para el dia en que alguien pregunte
-- "esto quien lo toco".
alter table public.leads
  add column if not exists etapa_at  timestamptz;
alter table public.leads
  add column if not exists etapa_por uuid references auth.users(id);

create index if not exists leads_cliente_etapa_idx
  on public.leads (cliente_id, etapa_portal);

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — La plantilla por defecto: las 11 etapas
--
-- `ghl_patrones` son los textos de GHL que caen en cada etapa, en minusculas
-- y sin acentos. Se comparan con LIKE, asi que 'no califica' agarra
-- "No Califica", "No Calificado" y "Lead no calificado" de una.
--
-- LA `prioridad` MANDA EN LA TRADUCCION, NO EL `orden`.
-- Los cierres y descartes tienen prioridad baja (se evaluan primero) porque
-- son especificos. 'reunion' y 'llamada' son patrones anchos: van al final,
-- si no le roban leads a "Segunda reunion".
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
-- PARTE 4 — Leer etapas: de quien son las decide el TOKEN, no el pedido
-- ════════════════════════════════════════════════════════════════════════════

-- Que etapas le tocan a un cliente: las suyas si tiene, si no la plantilla.
-- Ordenadas para MOSTRAR (por `orden`).
--
-- ⚠️  Esta funcion es `security definer`: bypasea RLS. Por eso NO puede confiar
--     en el `p_cliente` que le manda el navegador. Si el que llama no es
--     agencia, se le reemplaza por el suyo. Pedir lo ajeno no da error: da lo
--     propio.
create or replace function public.etapas_de(p_cliente text)
returns setof public.etapas
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.es_agencia() then
    p_cliente := public.mi_cliente();
  end if;

  return query
    select * from public.etapas
     where cliente_id = p_cliente
     union all
    select * from public.etapas
     where cliente_id is null
       and not exists (select 1 from public.etapas where cliente_id = p_cliente)
     order by orden;
end $$;

revoke all     on function public.etapas_de(text) from public, anon;
grant  execute on function public.etapas_de(text) to authenticated;


-- Traducir el texto crudo de GHL al slug de una etapa.
-- Recorre por `prioridad`, NO por `orden`. Gana el primero que matchea.
-- Hereda el filtro de `etapas_de`: un cliente no puede traducir con las etapas
-- de otro.
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

  return null;  -- a proposito: el sync pone 'nuevo' y la prueba te lo muestra
end $$;

revoke all     on function public.etapa_desde_ghl(text, text) from public, anon;
grant  execute on function public.etapa_desde_ghl(text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — Alta, baja, reordenar (solo agencia)
--
-- Los tres guardas usan `es_agencia()`, que nunca devuelve NULL.
-- ════════════════════════════════════════════════════════════════════════════

-- 5.a — Agregar una etapa.
--       Solo pide `equivale` (open / won / lost / abandoned).
--       El `grupo` se deduce solo y se puede corregir despues.
--       La `prioridad` entra al final, asi nunca le roba leads a una etapa
--       que ya existia.
create or replace function public.etapa_crear(
  p_cliente   text,
  p_slug      text,
  p_nombre    text,
  p_equivale  text,
  p_grupo     text    default null,   -- null = se deduce de equivale
  p_color     text    default null,
  p_patrones  text[]  default '{}'
)
returns public.etapas
language plpgsql security definer set search_path = public
as $$
declare v_grupo text; v_ord int; v_pri int; v_fila public.etapas;
begin
  if not public.es_agencia() then
    raise exception 'Solo la agencia puede crear etapas';
  end if;
  if p_equivale is null or p_equivale not in ('open','won','lost','abandoned') then
    raise exception 'Equivale invalido: % (open / won / lost / abandoned)', coalesce(p_equivale,'(null)');
  end if;

  -- El grupo se pre-rellena desde equivale. No se puede deducir al reves:
  -- 'open' cubre desde "Nuevo lead" hasta "Tomando decision".
  v_grupo := coalesce(p_grupo, case p_equivale
    when 'won'       then 'cerrado'
    when 'lost'      then 'cerrado'
    when 'abandoned' then 'frenado'
    else                  'avanzando'
  end);

  -- Entra ultima en los dos ordenes.
  select coalesce(max(orden),     0) + 10,
         coalesce(max(prioridad), 0) + 10
    into v_ord, v_pri
    from public.etapas
   where cliente_id is not distinct from p_cliente;

  insert into public.etapas
    (cliente_id, slug, nombre, grupo, equivale, orden, prioridad, color, pide_monto, ghl_patrones)
  values
    (p_cliente, p_slug, p_nombre, v_grupo, p_equivale, v_ord, v_pri, p_color,
     p_equivale = 'won', coalesce(p_patrones, '{}'))
  returning * into v_fila;

  return v_fila;
end $$;


-- 5.b — Borrar una etapa, diciendo A DONDE van los leads que estaban ahi.
--       Mudar y borrar pasan en la MISMA transaccion: si algo falla, no queda
--       ni media cosa hecha.
create or replace function public.etapa_borrar(
  p_cliente  text,
  p_slug     text,
  p_destino  text
)
returns int   -- cuantos leads se mudaron
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.es_agencia() then
    raise exception 'Solo la agencia puede borrar etapas';
  end if;
  if p_slug is not distinct from p_destino then
    raise exception 'El destino tiene que ser una etapa distinta';
  end if;

  -- El destino tiene que existir y estar activa, si no mudamos leads a la nada.
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


-- 5.c — Reordenar: se le pasa la lista de slugs en el orden que se quiere ver.
--       Toca SOLO `orden`. `prioridad` no se mueve, asi que reordenar en
--       pantalla nunca cambia a donde van los leads de GHL.
create or replace function public.etapas_reordenar(
  p_cliente text,
  p_slugs   text[]
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.es_agencia() then
    raise exception 'Solo la agencia puede reordenar etapas';
  end if;

  update public.etapas e
     set orden = pos.i * 10
    from unnest(coalesce(p_slugs,'{}')) with ordinality as pos(s, i)
   where e.slug = pos.s
     and e.cliente_id is not distinct from p_cliente;
end $$;


-- 5.d — RED DE SEGURIDAD: nadie borra una etapa con leads adentro por afuera
--       de etapa_borrar() (por ejemplo, desde el dashboard de Supabase).
--       No hace falta ninguna marca especial: etapa_borrar() muda primero,
--       asi que cuando llega al delete ya quedan cero y el trigger deja pasar.
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
-- PARTE 6 — La UNICA puerta por la que el cliente mueve un lead
--
-- ⚠️  p_lead_id es UUID. `leads.id` es uuid, no bigint. plpgsql no valida el
--     cuerpo de la funcion al crearla, asi que un tipo equivocado aca se crea
--     sin error y revienta recien la primera vez que alguien la llama.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_etapa(
  p_lead_id uuid,
  p_etapa   text,
  p_monto   numeric default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_cliente text; v_es_agencia boolean; v_lead_cli text; v_pide boolean;
begin
  v_es_agencia := public.es_agencia();   -- nunca NULL
  v_cliente    := public.mi_cliente();

  -- De quien es el lead. Sale de la tabla, no del pedido.
  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;

  -- Mismo mensaje exista o no el lead: no le confirmamos a nadie que un lead
  -- ajeno esta ahi.
  if v_lead_cli is null then
    raise exception 'Ese lead no existe';
  end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli is distinct from v_cliente) then
    raise exception 'Ese lead no existe';
  end if;

  -- La etapa tiene que existir, estar activa, y ser de ESE cliente.
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

  -- NOTA: a proposito NO tocamos `estado`. Esa columna es de GHL y el proximo
  -- sync la pisa. El `equivale` de la etapa es lo que va a servir el dia que
  -- le escribamos de vuelta a GHL.
end $$;

revoke all     on function public.lead_etapa(uuid, text, numeric) from public, anon;
grant  execute on function public.lead_etapa(uuid, text, numeric) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 7 — Como volver atras (deja todo exactamente como estaba)
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop trigger  if exists etapas_no_borrar_con_leads on public.etapas;
  drop function if exists public.etapa_sin_leads();
  drop function if exists public.etapas_reordenar(text,text[]);
  drop function if exists public.etapa_borrar(text,text,text);
  drop function if exists public.etapa_crear(text,text,text,text,text,text,text[]);
  drop function if exists public.lead_etapa(uuid, text, numeric);
  drop function if exists public.etapa_desde_ghl(text, text);
  drop function if exists public.etapas_de(text);
  drop table    if exists public.etapas;
  drop index    if exists public.leads_cliente_etapa_idx;
  alter table public.leads drop column if exists etapa_por;
  alter table public.leads drop column if exists etapa_at;
  alter table public.leads drop column if exists monto;
  alter table public.leads drop column if exists etapa_portal;
  -- es_agencia() NO se dropea: es una mejora de seguridad que conviene
  -- conservar aunque se vuelva atras todo lo demas. Si igual la querés sacar:
  --   drop function if exists public.es_agencia();
commit;
-- Seguro mientras `leads` este vacia. Con datos adentro, el drop de
-- `etapa_portal` borra el trabajo del cliente: exportar primero.
*/


-- ════════════════════════════════════════════════════════════════════════════
-- COMO SE PERSONALIZA (no hace falta migracion: son llamadas, no SQL nuevo)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Agregar una etapa (solo pide a que equivale; el grupo se deduce):
--   select public.etapa_crear(null, 'contrato', 'Esperando contrato', 'open');
--
-- Cambiarle el nombre (el slug NO se toca: los leads lo usan):
--   update public.etapas set nombre = 'Follow-up'
--    where cliente_id is null and slug = 'reunion2';
--
-- Reordenar (solo mueve como se ve, nunca la traduccion de GHL):
--   select public.etapas_reordenar(null,
--     array['nuevo','programando','reunion1','compro','no_compro']);
--
-- Archivar (deja de poder elegirse, los leads que estan ahi se siguen viendo):
--   update public.etapas set activa = false
--    where cliente_id is null and slug = 'reunion2';
--
-- Borrar de verdad, diciendo a donde van los leads:
--   select public.etapa_borrar(null, 'reunion2', 'reunion1');
--
-- Agregar un patron de GHL que quedo sin traducir:
--   update public.etapas
--      set ghl_patrones = ghl_patrones || array['lo que sea']
--    where cliente_id is null and slug = 'no_califica';
--
-- Etapas propias de un cliente. OJO: en cuanto un cliente tiene UNA etapa
-- propia, deja de ver la plantilla. Hay que copiarle las que quiera conservar:
--   insert into public.etapas
--     (cliente_id, slug, nombre, grupo, equivale, orden, prioridad, color, pide_monto, ghl_patrones)
--   select '1789917669862', slug, nombre, grupo, equivale, orden, prioridad, color, pide_monto, ghl_patrones
--     from public.etapas where cliente_id is null;
--   -- y recien despues agregarle o sacarle lo que sea
--
-- ════════════════════════════════════════════════════════════════════════════
-- PENDIENTE — NO correr ahora. Va cuando el portal ya use lead_etapa.
-- ════════════════════════════════════════════════════════════════════════════
--
-- `lead_marcar` (del 005) sigue viva y escribe `estado`, la columna de GHL.
-- No es un agujero: el cliente solo alcanza sus propios leads. Pero es una
-- segunda puerta que no queremos abierta, y lo que escriba ahi se lo pisa el
-- proximo sync.
--
-- Cuando el portal este andando contra lead_etapa y lo hayas comprobado:
--     revoke execute on function public.lead_marcar(uuid, text, numeric, text)
--       from authenticated;
--
-- Queda anotado en LIMPIEZA.md, seccion "Mejoras futuras".
-- ============================================================================
