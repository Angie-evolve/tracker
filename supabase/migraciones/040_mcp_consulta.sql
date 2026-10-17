-- 040 · Conector "Evolve OS · consulta" para el Claude de cada persona del equipo
--
-- POR QUE (Angie, 17/10/2026)
-- Santi tiene su propio Claude y necesita contexto: las llamadas de Angie, de
-- Joe y del resto, y en que anda cada cliente. Hasta ahora eso solo lo podia
-- leer el Claude de Angie, con la clave maestra del Llavero, que lee y escribe
-- todo -tokens de Meta y GHL incluidos-. Esa clave no se comparte.
--
-- La funcion `evolve-mcp` es un servidor MCP de SOLO LECTURA: busca llamadas,
-- devuelve transcripciones y muestra clientes sin tokens. No tiene ninguna
-- accion que escriba. Cada persona entra con una clave propia, que va en el
-- link del conector y se apaga desde aca.
--
-- `mcp_claves` guarda el HASH (sha256 en hex) de cada clave, nunca la clave.
-- `alcance` dice que ve esa persona:
--   {"llamadas":"todas"|"cartera", "clientes":"todos"|"cartera", "email":"..."}
--   "cartera" = los clientes donde `owner` es ese email.
--
-- Las dos tablas tienen RLS y CERO policies a proposito, igual que
-- fathom_keys: solo las toca la funcion con la service key. La app no las ve.

create table if not exists public.mcp_claves (
  id         bigserial primary key,
  persona    text not null,
  hash       text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  alcance    jsonb not null default '{"llamadas":"todas","clientes":"todos"}'::jsonb,
  activa     boolean not null default true,
  creada_at  timestamptz not null default now(),
  ultima_at  timestamptz
);

create table if not exists public.mcp_registro (
  id          bigserial primary key,
  clave_id    bigint,
  persona     text,
  herramienta text,
  args        text check (args is null or length(args) <= 1000),
  at          timestamptz not null default now()
);
create index if not exists mcp_registro_at on public.mcp_registro (at desc);

alter table public.mcp_claves   enable row level security;
alter table public.mcp_registro enable row level security;

-- La funcion usa la service key: una tabla nueva no le da permisos sola.
grant select, insert, update on public.mcp_claves   to service_role;
grant select, insert         on public.mcp_registro to service_role;
grant usage on sequence public.mcp_claves_id_seq   to service_role;
grant usage on sequence public.mcp_registro_id_seq to service_role;

notify pgrst, 'reload schema';

-- APAGAR LA CLAVE DE ALGUIEN (sin borrar nada):
--   update public.mcp_claves set activa = false where persona = 'Santi';
--
-- COMO SE VUELVE ATRAS
--   drop table if exists public.mcp_registro;
--   drop table if exists public.mcp_claves;
--   (y borrar la funcion evolve-mcp en Supabase)
