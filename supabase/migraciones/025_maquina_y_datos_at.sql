-- ============================================================================
-- 025_maquina_y_datos_at.sql   —   PASO 1 de "separar lo que escribe una
--                                   maquina de lo que edita una persona"
--
-- ⚠️  ESTE ARCHIVO NO CAMBIA LO QUE VE NADIE. Agrega dos columnas que nacen
--     vacias y un trigger que solo escribe en una de ellas. Ningun dato se
--     mueve, ninguna policy se toca, y `index.html` todavia no las lee. Se
--     puede correr en cualquier momento y el tracker sigue igual que ayer.
--
-- EL PROBLEMA QUE VIENE A ARREGLAR
--   `citasAuto` le estampa `citasAt = now()` a TODOS los clientes cada 6
--   minutos, cambie algo o no (index.html, `_citasAplicar`). Eso les cambia la
--   huella a los 50 y los sube a los 50. Medido el 2026-09-25: las 50 filas
--   de `clientes` reescritas a las 15:54:07, todas por la misma cuenta, todas
--   con el mismo `citasAt` de 15:53:09.
--
--   Y `sbSubir` tiene un guarda anti-pisada: antes de subir un cliente compara
--   el `actualizado` de la nube contra el que vio la ultima vez, y si cambio
--   NO sube. Con el latido de una sesion corriendo, la OTRA sesion no puede
--   subir nada: se le rechaza cada guardado con un toast que pasa y se va.
--   Dos personas no pueden editar el tracker al mismo tiempo, y la que pierde
--   no se entera. Paso de verdad: un token de GHL cargado dos veces que nunca
--   llego a la base.
--
-- POR QUE HACEN FALTA DOS COLUMNAS Y NO UNA
--   La primera idea es mover lo que escribe la maquina a una columna aparte.
--   Sola no alcanza: `clientes_tocar` es un BEFORE INSERT OR UPDATE que hace
--   `new.actualizado = now()` en CUALQUIER escritura, asi que tocar solo la
--   columna nueva igual mueve `actualizado` y el guarda sigue chocando.
--   Entonces van las dos:
--     1. `maquina`  — donde vive lo regenerable.
--     2. `datos_at` — cuando cambio `datos` DE VERDAD, que es contra lo que el
--                     guarda tiene que comparar de ahora en mas.
--
-- ⚠️  `clientes_tocar` NO SE TOCA. Sigue marcando `actualizado` en cada
--     escritura, que es lo que tiene que hacer: dice cuando se escribio la
--     fila. Lo que faltaba era otra cosa distinta —cuando cambio lo que edita
--     una persona— y eso es una columna nueva, no un cambio en la vieja.
--
-- TODO ES ADITIVO: dos columnas con default, una funcion y un trigger nuevos.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — `maquina`: lo que se regenera solo
-- ════════════════════════════════════════════════════════════════════════════

alter table public.clientes
  add column if not exists maquina jsonb not null default '{}'::jsonb;

comment on column public.clientes.maquina is
  'Lo que escribe un proceso automatico y se regenera solo: citasAt, '
  'metaPulso, lpStats, _metaSnapshot, fathomBuscadoAt. Se pisa sin preguntar '
  '—el que midio ultimo tiene razon— y por eso vive fuera de `datos`, que es '
  'lo que edita una persona y no se puede perder.';

-- ⚠️  LOS GRANTS NO HAY QUE TOCARLOS, pero conviene saber por que.
--     `authenticated` tiene SELECT/INSERT/UPDATE/DELETE a nivel TABLA, no
--     columna por columna: una columna nueva queda cubierta sola. Si algun dia
--     alguien pasa esos grants a nivel columna, hay que acordarse de agregar
--     estas dos, o la app empieza a fallar con un 403 que no dice cual columna.
--
--     La policy tampoco cambia: `agencia_clientes` filtra por
--     `cartera_alcanza(datos)`, y `datos` sigue siendo `datos`. La cartera se
--     decide por el owner que esta ahi adentro, no por la columna nueva.


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — `datos_at`: cuando cambio lo que edita una persona
-- ════════════════════════════════════════════════════════════════════════════

alter table public.clientes
  add column if not exists datos_at timestamptz;

comment on column public.clientes.datos_at is
  'Ultima vez que `datos` cambio de verdad. `actualizado` se mueve con '
  'cualquier escritura (incluida la de `maquina`); esta solo cuando cambio lo '
  'que edita una persona. Es contra esta que `sbSubir` compara para decidir si '
  'otra sesion piso al cliente.';

-- Arranca igual a `actualizado`: es lo ultimo que se sabe de cada fila, y
-- dejarla en NULL obligaria a la app a tratar el primer guardado de cada
-- cliente como un caso especial.
update public.clientes set datos_at = actualizado where datos_at is null;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — el trigger que mantiene `datos_at`
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.tocar_datos_at()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    new.datos_at = now();
  elsif new.datos is distinct from old.datos then
    new.datos_at = now();
  else
    -- ⚠️  ESTE `else` NO SOBRA. Sin el, un UPDATE que mande `datos_at` en el
    --     cuerpo (por error, o porque alguien hace un select * y lo devuelve
    --     entero) puede escribir cualquier fecha. Con esto, la columna solo la
    --     mueve este trigger y nadie mas.
    new.datos_at = old.datos_at;
  end if;
  return new;
end $$;

-- ⚠️  `is distinct from` sobre jsonb compara POR VALOR, no por texto: el orden
--     de las claves de un objeto no cuenta, ni los espacios. Guardar el mismo
--     cliente dos veces con las claves en otro orden no mueve la fecha, que es
--     justo lo que queremos. (El orden de un ARRAY si cuenta: dos listas con
--     los mismos elementos en distinto orden son distintas. Si algun dia
--     aparece un array que se reordena solo, se va a notar como guardados que
--     nadie hizo.)

drop trigger if exists clientes_datos_at on public.clientes;
create trigger clientes_datos_at
  before insert or update on public.clientes
  for each row execute function public.tocar_datos_at();

-- ⚠️  LOS DOS TRIGGERS CONVIVEN. Postgres los corre por orden alfabetico de
--     nombre: `clientes_datos_at` antes que `clientes_tocar`. Como cada uno
--     escribe una columna distinta, el orden no cambia el resultado; queda
--     anotado para que nadie tenga que deducirlo el dia que agregue un tercero.


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — Las dos columnas existen, `maquina` vacia en todos y `datos_at` cargada.
select count(*) as clientes,
       count(*) filter (where maquina = '{}'::jsonb) as maquina_vacia,
       count(*) filter (where datos_at is null)      as sin_datos_at
  from public.clientes;

-- ⚠️  maquina_vacia = el total, sin_datos_at = 0. Nada se movio.


-- b — Los dos triggers, en orden.
select tgname from pg_trigger
 where tgrelid = 'public.clientes'::regclass and not tgisinternal
 order by tgname;

-- ⚠️  clientes_datos_at, clientes_tocar. En ese orden.


-- c — LA PRUEBA QUE IMPORTA: escribir `maquina` mueve `actualizado` pero NO
--     mueve `datos_at`. Si esto no da asi, el guarda de la app va a seguir
--     chocando y no sirvio de nada.
--
-- ⚠️  ESCRIBE DE VERDAD Y LO DESHACE. Un trigger no se prueba sin escribir.
--     Va entero adentro de una transaccion: el `rollback` del final deja la
--     base como estaba. Se corre de una sola vez, no de a pedazos, o la
--     transaccion queda abierta.
begin;
create temp table _antes on commit drop as
  select id, actualizado, datos_at from public.clientes order by id limit 1;

update public.clientes c set maquina = c.maquina || '{"_prueba":true}'::jsonb
  from _antes a where c.id = a.id;

select (c.actualizado > a.actualizado) as actualizado_se_movio,
       (c.datos_at    = a.datos_at)    as datos_at_quedo_igual
  from public.clientes c join _antes a on a.id = c.id;
rollback;

-- ⚠️  Las dos columnas en `true`. Corrido el 2026-09-25: dio true | true.
--     Y el control de que no quedo nada escrito:
--       select count(*) from public.clientes where maquina ? '_prueba';  -- 0


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- Mientras `index.html` no lea las columnas nuevas, esto se puede deshacer sin
-- perder nada: `maquina` esta vacia y `datos_at` no la usa nadie.
--
-- DESPUES de que salga el commit de index.html, borrar `maquina` SI borra
-- datos —el ultimo pulso de Meta, las ultimas metricas de la landing— pero
-- todos se vuelven a bajar solos en la siguiente sincronizacion. Lo que NO se
-- puede es borrar `maquina` sin volver atras tambien el index.html: la app
-- escribiria en una columna que no existe y el guardado entero empezaria a
-- fallar.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop trigger  if exists clientes_datos_at on public.clientes;
  drop function if exists public.tocar_datos_at();
  alter table public.clientes drop column if exists datos_at;
  alter table public.clientes drop column if exists maquina;
commit;
*/
-- ============================================================================
