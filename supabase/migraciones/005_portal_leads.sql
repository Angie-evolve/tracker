-- ============================================================================
-- 005_portal_leads.sql
--
-- QUÉ AGREGA: la tabla que el portal le muestra al cliente, y la única forma
-- en que el cliente puede escribir en ella.
--
-- POR QUÉ `estado` Y NO `etapa`: se midieron las 1822 oportunidades que hay
-- hoy. `status` de GHL tiene 4 valores consistentes -open, abandoned, lost,
-- won-. `pipelineStage` tiene 45 variantes, muchas la misma cosa escrita
-- distinto por cada subcuenta: "No Califica" / "No Calificado" / "Lead no
-- calificado", "Llamada Agendada" / "1ra llamada programada". Y los dos estan
-- desacoplados: 819 oportunidades en "No Calificado" siguen con status open.
-- Por eso `estado` es el dato que manda y `etapa` queda informativa.
--
-- CÓMO ESCRIBE EL CLIENTE: solo por lead_marcar(). No hay policy de insert,
-- update ni delete para el, asi que no hay otra puerta. La funcion toca cinco
-- columnas y ninguna mas: el nombre, el telefono y la etapa son intocables
-- porque la funcion ni los nombra.
-- ============================================================================

begin;

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  text not null,
  ghl_id      text,
  -- Los dos nombres que trae GHL: el de la persona y el de la oportunidad.
  nombre      text,
  opp_nombre  text,
  origen      text,
  campania    text,
  creado_at   timestamptz,
  -- Informativa. Viene de pipelineStage y el cliente no la toca.
  etapa       text,
  -- La que manda. Los cuatro valores de GHL, y el check los deja en cuatro.
  estado      text not null default 'open'
              check (estado in ('open','won','lost','abandoned')),
  valor       numeric,
  nota        text,
  -- Quien y cuando movio el estado. Sin esto, un lead marcado como ganado no
  -- dice si lo movio el cliente o una sincronizacion.
  estado_at   timestamptz,
  estado_por  uuid references auth.users(id) on delete set null,
  unique (cliente_id, ghl_id)
);

create index if not exists leads_cliente_creado_idx
  on public.leads (cliente_id, creado_at desc);

alter table public.leads enable row level security;
revoke all on public.leads from anon;

-- ###########################################################################
-- #  `authenticated` conserva el grant de escritura A PROPOSITO, porque la  #
-- #  agencia sincroniza leads desde el navegador. Quien separa es la        #
-- #  policy. NO copiar aca el revoke de `perfiles`: rompe la               #
-- #  sincronizacion.                                                        #
-- ###########################################################################
--
-- En `perfiles` el segundo candado -sin grant Y sin policy- es gratis: nadie
-- escribe esa tabla desde el navegador. Aca no lo es. El dia que la
-- sincronizacion de GHL pase a una edge function con service_role, el revoke
-- pasa a ser gratis y ahi si conviene agregarlo. Esta anotado en LIMPIEZA.md.
grant select, insert, update, delete on public.leads to authenticated;
grant select, insert, update on public.leads to service_role;

drop policy if exists "agencia_leads"  on public.leads;
drop policy if exists "cliente_leads"  on public.leads;

create policy "agencia_leads" on public.leads
  for all to authenticated
  using      (public.mi_rol() = 'agencia')
  with check (public.mi_rol() = 'agencia');

-- El cliente ve lo suyo y nada mas. Solo select: no hay policy de insert,
-- update ni delete para el, y lo que no tiene policy no se puede.
create policy "cliente_leads_ve" on public.leads
  for select to authenticated
  using (public.mi_rol() = 'cliente' and cliente_id = public.mi_cliente());

-- ── La unica puerta de escritura del cliente ────────────────────────────────
-- security definer: corre con los permisos del owner, asi que puede escribir
-- una tabla donde el cliente no tiene grant. Por eso valida todo adentro.
create or replace function public.lead_marcar(
  p_lead   uuid,
  p_estado text,
  p_valor  numeric default null,
  p_nota   text    default null)
returns public.leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads;
  v_rol  text := public.mi_rol();
  v_cli  text := public.mi_cliente();
begin
  -- 1. El estado tiene que ser uno de los cuatro. El check de la tabla ya lo
  --    impide, pero fallar aca da un mensaje que se entiende.
  if p_estado is null or p_estado not in ('open','won','lost','abandoned') then
    raise exception 'Estado invalido: %. Tiene que ser open, won, lost o abandoned', p_estado
      using errcode = '22023';
  end if;

  -- 2. El lead tiene que existir Y ser de quien llama. La agencia puede marcar
  --    cualquiera; el cliente, solo los suyos. Un lead ajeno da "no existe" y
  --    no "no podes": no hay por que confirmarle que existe.
  select * into v_lead from public.leads where id = p_lead;
  if not found
     or (v_rol = 'cliente' and (v_cli is null or v_lead.cliente_id is distinct from v_cli))
     or (v_rol is distinct from 'cliente' and v_rol is distinct from 'agencia') then
    raise exception 'Ese lead no existe' using errcode = 'P0002';
  end if;

  -- 3. Se tocan cinco columnas y ninguna mas. El nombre, el telefono, el
  --    origen y la etapa quedan intactos porque no aparecen en este update.
  update public.leads
     set estado     = p_estado,
         valor      = coalesce(p_valor, valor),
         nota       = coalesce(p_nota,  nota),
         estado_at  = now(),
         estado_por = auth.uid()
   where id = p_lead
  returning * into v_lead;

  return v_lead;
end $$;

revoke all on function public.lead_marcar(uuid, text, numeric, text) from public;
grant execute on function public.lead_marcar(uuid, text, numeric, text) to authenticated;

commit;


-- ── Vuelta atrás ────────────────────────────────────────────────────────────
-- Borra la tabla con sus datos. Si ya hay leads cargados, exportarlos antes.
/*
begin;
  drop function if exists public.lead_marcar(uuid, text, numeric, text);
  drop table if exists public.leads;
commit;
*/

-- NOTA: `estado_por` guarda quien lo movio, y queda en null si esa cuenta se
-- borra (on delete set null) en vez de llevarse el lead por delante.
--
-- NOTA: no hay policy de delete para nadie salvo la de agencia. Un lead que
-- deja de estar en GHL se marca, no se borra: el historial de lo que el
-- cliente vio y marco tiene que sobrevivir a una sincronizacion.
