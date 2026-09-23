-- ============================================================================
-- 024_fathom_varias_keys.sql
--
-- QUE ARREGLA
-- Una sola cuenta de Fathom por persona. `fathom_keys` tiene
-- `primary key (email)` y la funcion guarda ahi el mail de la PERSONA, asi que
-- conectarle un segundo Fathom a alguien no agregaba una fila: pisaba la que
-- ya tenia. El `on_conflict=email,merge-duplicates` de la funcion lo hacia en
-- silencio, sin error y sin aviso, y desde la app se veia igual de verde.
--
-- LO QUE YA FUNCIONABA
-- El lado que BUSCA no tiene ese problema: se trae todas las filas y le
-- pregunta a cada key por separado —"cada una ve solo las grabaciones de su
-- dueno, asi que para cubrir al equipo hay que preguntarle a todas"—. O sea
-- que N keys ya se aprovechan; lo unico que faltaba era poder guardarlas.
--
-- COMO SE RESUELVE SIN TOCAR LA CLAVE PRIMARIA
-- ⚠️  Cambiar la PK seria un `drop constraint`, que es justo lo que el
--     CLAUDE.md pide no hacer. No hace falta: la PK pasa a significar lo que
--     de verdad es unico, LA CUENTA DE FATHOM, y quien la usa se guarda
--     aparte. Dos cuentas de Joela son dos mails distintos, asi que son dos
--     filas sin que la PK se entere.
--
--     `email`   = el mail de la cuenta de Fathom (lo que Fathom llama
--                 `recorded_by.email`, que la funcion ya venia guardando en
--                 `duenio`).
--     `persona` = de quien del equipo es esa cuenta. Es lo nuevo.
--
--     Para las filas de antes las dos cosas son el mismo mail, asi que el
--     backfill las deja idénticas a como estaban y nada cambia de lugar.
--
-- TODO ESTO ES ADITIVO: una columna y un indice. Ningun drop, ningun rename,
-- ningun tipo cambiado.
--
-- ⚠️  `fathom_keys` GUARDA CREDENCIALES: tiene RLS prendida y CERO policies a
--     proposito, y esta migracion no le agrega ninguna. Solo la alcanza la
--     service_role desde adentro de la funcion. El navegador no la lee ni
--     antes ni despues de esto.
-- ============================================================================

begin;

alter table public.fathom_keys
  add column if not exists persona text;

-- Las filas viejas se conectaron con el mail de la persona en `email`, asi que
-- para ellas las dos columnas valen lo mismo. Sin este backfill quedarian con
-- `persona` en null y la pantalla de Personas no las encontraria: una key
-- cargada y funcionando se veria como desconectada.
update public.fathom_keys
   set persona = email
 where persona is null;

comment on column public.fathom_keys.email is
  'El mail de la cuenta de Fathom. Es la clave primaria: una fila por cuenta.';
comment on column public.fathom_keys.persona is
  'De quien del equipo es esta cuenta. Una persona puede tener varias.';

-- Se busca por persona para armar la lista de la pantalla de Personas, y
-- siempre en minusculas porque los mails se escriben de las dos formas.
create index if not exists fathom_keys_persona_idx
  on public.fathom_keys (lower(persona));

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

-- a — La columna y el indice existen.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='fathom_keys'
      and column_name='persona')                                  as columna,
  (select count(*) from pg_indexes
    where schemaname='public' and indexname='fathom_keys_persona_idx') as indice;
-- ⚠️  columna = 1, indice = 1

-- b — Ninguna fila quedo sin persona.
select count(*) as sin_persona from public.fathom_keys where persona is null;
-- ⚠️  tiene que ser 0

-- c — Las filas de antes no se movieron: email y persona son el mismo mail.
select count(*) as filas,
       count(*) filter (where lower(persona)=lower(email)) as iguales
  from public.fathom_keys;

-- d — La tabla sigue sin policies. Esto NO tiene que cambiar nunca.
select relrowsecurity as rls_prendida,
       (select count(*) from pg_policy where polrelid='public.fathom_keys'::regclass) as policies
  from pg_class where oid='public.fathom_keys'::regclass;
-- ⚠️  rls_prendida = true, policies = 0


-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
--
-- La columna se puede dejar sin que moleste: la funcion vieja no la mira y la
-- nueva la completa sola. Borrarla solo hace falta si se quiere el estado
-- exacto de antes, y hay que hacerlo con la funcion vieja ya desplegada, o la
-- proxima alta falla al escribir una columna que no existe.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  drop index if exists public.fathom_keys_persona_idx;
  alter table public.fathom_keys drop column if exists persona;
commit;
*/
-- ============================================================================
