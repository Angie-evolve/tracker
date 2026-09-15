-- ============================================================
--  Cola de pedidos de estaticos
--
--  Supabase -> SQL Editor -> New query -> pegar todo -> Run.
--
--  La app no puede hablarle ni a Claude ni a Higgsfield sin exponer claves en
--  un repo publico. Asi que no habla: deja el pedido aca y lo levanta un worker
--  que corre en la maquina de Angie, donde esas credenciales ya viven.
--
--  Una fila por pedido. El worker la reclama, la trabaja y escribe el
--  resultado en la misma fila: la app mira esa fila y no necesita saber nada
--  mas de como se hizo.
-- ============================================================

create table if not exists estaticos_pedidos (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid references auth.users(id) not null default auth.uid(),
  pedido_por  text default (auth.jwt() ->> 'email'),
  -- angulos | imagenes. Son los dos pasos que hoy se hacen a mano.
  tipo        text not null check (tipo in ('angulos','imagenes')),
  estado      text not null default 'pendiente'
              check (estado in ('pendiente','procesando','listo','error')),
  -- Lo que hace falta para trabajarlo: el documento y las opciones para
  -- angulos, la lista de prompts para imagenes.
  entrada     jsonb not null,
  salida      jsonb,
  error       text,
  creado_at   timestamptz default now(),
  -- Si el worker muere a mitad de camino, la fila queda en procesando para
  -- siempre. Con la marca de cuando la tomo se puede reciclar sola.
  tomado_at   timestamptz,
  listo_at    timestamptz
);

create index if not exists estaticos_pedidos_cola_idx
  on estaticos_pedidos (estado, creado_at);

alter table estaticos_pedidos enable row level security;

-- Lo ve y lo crea el equipo, con la misma definicion que ya usa el Editor: asi
-- no hay dos listas de quien es del equipo que puedan quedar desincronizadas.
drop policy if exists "el equipo ve los pedidos"   on estaticos_pedidos;
drop policy if exists "el equipo crea pedidos"     on estaticos_pedidos;
drop policy if exists "el equipo borra sus pedidos" on estaticos_pedidos;

create policy "el equipo ve los pedidos" on estaticos_pedidos
  for select using (auth.uid() = usuario_id or es_del_equipo());
create policy "el equipo crea pedidos" on estaticos_pedidos
  for insert with check (auth.uid() = usuario_id and es_del_equipo());
create policy "el equipo borra sus pedidos" on estaticos_pedidos
  for delete using (auth.uid() = usuario_id or es_del_equipo());

-- No hay policy de update para los usuarios, igual que en trabajos_video: el
-- estado y la salida los escribe solo el worker. Si la app pudiera tocarlos,
-- un bug del navegador podria marcar listo algo que no se hizo.
grant select, insert, delete on estaticos_pedidos to authenticated;
grant select, insert, update, delete on estaticos_pedidos to service_role;

-- ------------------------------------------------------------
--  Un tope, porque cada pedido gasta el plan de Claude y los creditos de
--  Higgsfield de Angie, y lo encola cualquiera del equipo. Sin esto, una tanda
--  de 28 repetida tres veces se lleva el mes.
-- ------------------------------------------------------------
create or replace function estaticos_tope()
returns trigger
language plpgsql
as $$
declare hoy int;
begin
  select count(*) into hoy
    from estaticos_pedidos
   where creado_at > now() - interval '24 hours';
  if hoy >= 20 then
    raise exception 'Ya hay 20 pedidos en las ultimas 24 horas. Es el tope, para que una tanda repetida no se lleve los creditos del mes.';
  end if;
  return new;
end $$;

drop trigger if exists estaticos_tope_trg on estaticos_pedidos;
create trigger estaticos_tope_trg
  before insert on estaticos_pedidos
  for each row execute function estaticos_tope();
