-- 039 · Pedidos al agente: se preparan solos, se ejecutan con una persona
--
-- POR QUE (Angie, 14/10/2026)
-- Muchos cambios propuestos son mecanicos -pausar un anuncio, activar un
-- calendario, dejar escritas las respuestas a los leads-. "Mandar al agente"
-- los deja aca. Una rutina los PREPARA: lee Meta y GHL (solo lectura) y escribe
-- el plan -que cambia exactamente, el antes, el texto de los mensajes, lo que
-- puede salir mal-. No toca ninguna cuenta.
-- La ejecucion la hace Claude en una conversacion con Angie presente, despues
-- de que ella toca "Hacelo" en el tracker. Nada se ejecuta sin una persona.
--
-- Estados:
--   pendiente  recien pedido desde el tracker
--   preparado  la rutina dejo el plan en `propuesta`
--   aprobado   una persona toco "Hacelo": se ejecuta en la proxima conversacion
--   hecho      ejecutado, con `resultado` (que se hizo, antes y despues)
--   fallo      no se pudo, con el porque en `resultado`
--   cancelado  una persona lo freno
--
-- RLS como el resto: solo rol agencia. Una persona puede pedir (pendiente),
-- aprobar o cancelar; preparar y cerrar lo hace la service key. Ninguna
-- credencial vive en esta tabla.

create table if not exists public.agente_pedidos (
  id             bigserial primary key,
  cliente_id     bigint not null,
  cambio_id      text,
  texto          text not null check (length(texto) between 1 and 400),
  porque         text check (porque is null or length(porque) <= 800),
  pedido_por     text,
  estado         text not null default 'pendiente'
                 check (estado in ('pendiente','preparado','aprobado','hecho','fallo','cancelado')),
  propuesta      text check (propuesta is null or length(propuesta) <= 6000),
  resultado      text check (resultado is null or length(resultado) <= 4000),
  ok_por         text,
  ok_at          timestamptz,
  creado_at      timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);

create index if not exists agente_pedidos_estado  on public.agente_pedidos (estado, creado_at);
create index if not exists agente_pedidos_cliente on public.agente_pedidos (cliente_id, creado_at desc);

alter table public.agente_pedidos enable row level security;

drop policy if exists "agencia lee pedidos" on public.agente_pedidos;
create policy "agencia lee pedidos" on public.agente_pedidos
  for select to authenticated using (public.es_agencia());

drop policy if exists "agencia pide" on public.agente_pedidos;
create policy "agencia pide" on public.agente_pedidos
  for insert to authenticated
  with check (public.es_agencia() and estado = 'pendiente' and propuesta is null and resultado is null);

-- Una persona solo aprueba o cancela. Preparar y cerrar lo hace la service key.
drop policy if exists "agencia aprueba o cancela" on public.agente_pedidos;
create policy "agencia aprueba o cancela" on public.agente_pedidos
  for update to authenticated
  using (public.es_agencia() and estado in ('pendiente','preparado','aprobado'))
  with check (public.es_agencia() and estado in ('aprobado','cancelado'));

grant select, insert, update on public.agente_pedidos to authenticated;
grant usage on sequence public.agente_pedidos_id_seq to authenticated;
-- La rutina que prepara y la conversacion que ejecuta usan la service key: una
-- tabla nueva no le da permisos sola.
grant select, insert, update on public.agente_pedidos to service_role;
grant usage on sequence public.agente_pedidos_id_seq to service_role;

create or replace function public.agente_pedidos_tocado()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin NEW.actualizado_at := now(); return NEW; end $$;
drop trigger if exists agente_pedidos_tocado on public.agente_pedidos;
create trigger agente_pedidos_tocado before update on public.agente_pedidos
  for each row execute function public.agente_pedidos_tocado();

notify pgrst, 'reload schema';

-- COMO SE VUELVE ATRAS
--   drop table if exists public.agente_pedidos;
--   drop function if exists public.agente_pedidos_tocado();
