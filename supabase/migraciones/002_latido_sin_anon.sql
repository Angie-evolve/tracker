-- ============================================================================
-- 002_latido_sin_anon.sql
--
-- QUÉ ARREGLA: `latido` era la única tabla que `anon` podía leer, o sea
-- cualquiera con la publishable key, que está en un repo público. El grant no
-- tenía razón de ser: la tabla no tiene lector ni escritor en todo el repo
-- -ni en index.html, ni en editor-ia/, ni en supabase/functions/-, tiene una
-- sola fila del 4/8/2026, y ni siquiera service_role puede escribirla.
--
-- La tabla NO se borra: eso es un drop, y la zona COMPARTIDA solo suma.
-- Queda anotada en LIMPIEZA.md como candidata.
--
-- Despues de esto, ninguna tabla de public le da SELECT a anon. Lo único que
-- anon todavía puede hacer es INSERT en lp_eventos, que es a propósito: es el
-- snippet de tracking que se pega en las landings de GHL.
-- ============================================================================

revoke select on public.latido from anon;


-- ── Vuelta atrás ────────────────────────────────────────────────────────────
/*
grant select on public.latido to anon;
*/
