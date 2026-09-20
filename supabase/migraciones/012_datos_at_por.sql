-- ============================================================================
-- 012_datos_at_por.sql
--
-- QUE ARREGLA
-- `lead_datos` (010) escribe `etapa_at` y `etapa_por` aunque solo toque la
-- nota y el monto. O sea que esas dos columnas mienten: dicen "alguien movio
-- la etapa el dia tal" cuando lo unico que pasó fue que se escribio una nota.
--
-- Se nota en los datos: hay 5 leads con `etapa_por` cargado y solo 4 con la
-- etapa movida. El quinto tiene la etapa donde la dejo la traduccion de GHL.
--
-- Importa porque el tracker va a mostrar "esto lo marco el cliente", y esa
-- frase se apoya justo en esas dos columnas. Con el bug, una nota se veria
-- como una decision sobre la etapa.
--
-- QUE HACE
--   1. Dos columnas nuevas: `datos_at` y `datos_por`, para la nota y el monto.
--   2. `lead_datos` pasa a escribir esas, y deja de tocar las de la etapa.
--   3. Limpia las filas que quedaron estampadas sin que la etapa se moviera.
--
-- TODO ES ADITIVO salvo el punto 3, que es un `update` acotado y reversible
-- solo en el sentido de que no borra nada que no sea ese sello falso.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — Las columnas
--
-- `on delete set null` igual que `estado_por`: si se borra la cuenta de quien
-- escribio la nota, la nota se queda. El dato del lead no depende de que la
-- persona siga existiendo.
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table public.leads
  add column if not exists datos_at  timestamptz;

alter table public.leads
  add column if not exists datos_por uuid references auth.users(id) on delete set null;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — `lead_datos` deja de mentir
--
-- Cambian DOS renglones del update y nada mas. Las guardas quedan iguales:
-- son las mismas que las de `lead_etapa`, a proposito.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.lead_datos(
  p_lead_id uuid,
  p_nota text default null,
  p_monto numeric default null,
  p_borrar_nota boolean default false,
  p_borrar_monto boolean default false)
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

  if p_monto is not null and p_monto < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;

  update public.leads
     set nota  = case when p_borrar_nota  then null else coalesce(p_nota,  nota)  end,
         monto = case when p_borrar_monto then null else coalesce(p_monto, monto) end,
         -- ⚠️  ACA ESTABA EL BUG: esto decia `etapa_at` y `etapa_por`.
         --     Escribir una nota no es mover la etapa. Cada par de columnas
         --     cuenta lo suyo y no se pisan.
         datos_at  = now(),
         datos_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_datos(uuid, text, numeric, boolean, boolean) from public, anon;
grant  execute on function public.lead_datos(uuid, text, numeric, boolean, boolean) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — Limpiar el sello falso
--
-- Se borra `etapa_at`/`etapa_por` SOLO donde el sello no puede ser de una
-- mudanza de etapa: la etapa quedo exactamente donde la puso la traduccion de
-- GHL, y no hay ni nota ni monto que justifique otra cosa.
--
-- ⚠️  NO se borra por id ni por nombre: se borra por lo que dice el dato. Un
--     id escrito a mano en un archivo versionado es justo lo que no va.
--
-- ⚠️  Que sea acotado importa: hay 4 leads con la etapa movida de verdad, y
--     esos NO se tocan. Si este update dijera "todos los que tengan
--     etapa_por", les borraria el sello bueno a esos cuatro.
-- ════════════════════════════════════════════════════════════════════════════

begin;

update public.leads
   set etapa_at = null, etapa_por = null
 where etapa_por is not null
   and nota  is null
   and monto is null
   and etapa_portal is not distinct from public.etapa_desde_ghl(etapa, cliente_id);

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Las columnas existen y son del tipo que corresponde.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='leads'
   and column_name in ('datos_at','datos_por','etapa_at','etapa_por')
 order by column_name;

-- ⚠️  Cuatro filas. `datos_at` y `etapa_at` timestamptz, los dos `_por` uuid.


-- b — El sello de la etapa ahora solo esta donde la etapa se movio de verdad.
select
  count(*) filter (where etapa_por is not null)                          as con_sello_de_etapa,
  count(*) filter (where etapa_portal
        is distinct from public.etapa_desde_ghl(etapa, cliente_id))      as etapa_movida,
  count(*) filter (where datos_por is not null)                          as con_sello_de_datos
from public.leads;

-- ⚠️  `con_sello_de_etapa` tiene que ser igual a `etapa_movida`: 4 y 4.
--     Antes eran 5 y 4.


-- c — Que los 4 que se movieron de verdad NO perdieron su sello.
select left(id::text,8) as lead, etapa_portal,
       public.etapa_desde_ghl(etapa, cliente_id) as decia_ghl,
       (etapa_por is not null) as conserva_el_sello
  from public.leads
 where etapa_portal is distinct from public.etapa_desde_ghl(etapa, cliente_id)
 order by etapa_at;

-- ⚠️  Cuatro filas, las cuatro con `conserva_el_sello` en true.


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- El sello borrado en la PARTE 3 no vuelve: era falso, no hay a que volver.
-- Lo que se puede deshacer es el resto.
-- ════════════════════════════════════════════════════════════════════════════
/*
-- `lead_datos` como estaba en el 010 (con el bug):
create or replace function public.lead_datos(
  p_lead_id uuid, p_nota text default null, p_monto numeric default null,
  p_borrar_nota boolean default false, p_borrar_monto boolean default false)
returns void language plpgsql security definer set search_path = public
as $$
declare v_lead_cli text; v_es_agencia boolean; v_cliente text;
begin
  v_es_agencia := public.es_agencia();
  v_cliente    := public.mi_cliente();
  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;
  if v_lead_cli is null then raise exception 'Ese lead no existe'; end if;
  if not v_es_agencia and (v_cliente is null or v_lead_cli is distinct from v_cliente) then
    raise exception 'Ese lead no existe';
  end if;
  if p_monto is not null and p_monto < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;
  update public.leads
     set nota  = case when p_borrar_nota  then null else coalesce(p_nota,  nota)  end,
         monto = case when p_borrar_monto then null else coalesce(p_monto, monto) end,
         etapa_at = now(), etapa_por = auth.uid()
   where id = p_lead_id;
end $$;

begin;
  alter table public.leads drop column if exists datos_por;
  alter table public.leads drop column if exists datos_at;
commit;
*/
-- ============================================================================
