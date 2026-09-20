-- ============================================================================
-- 004_cerrar_tablas_internas.sql
--
-- QUÉ ARREGLA: la 001 cerró `clientes`, `config` y `llamadas_fathom`, pero
-- otras cinco tablas quedaron con policies que dicen `true` o que solo piden
-- ser el dueño de la fila. Se escribieron cuando "logueado" y "de la agencia"
-- eran lo mismo; desde que existe el rol `cliente`, dejaron de serlo.
--
-- Medido con un perfil `cliente` simulado, un cliente podía:
--   ia_jobs           leer 231 filas  +  insertar (pasaba los permisos)
--   lp_eventos        leer 2879 filas de toda la cartera
--   equipo_video      leer las 4 filas, con los mails del equipo
--   ejemplos_edicion  insertar a su nombre
--   trabajos_video    insertar a su nombre
--
-- CRITERIO: cerrar todo primero. Nada de filtrar por cliente todavía: cuando
-- el portal necesite mostrarle SUS datos, eso es otra migración y otra
-- decisión -para `lp_eventos` va a ser `cliente = mi_cliente()`, no `true`-.
--
-- SOBRE es_del_equipo(): es `security definer` y su owner es `postgres`, que
-- tiene BYPASSRLS y SELECT sobre equipo_video. Cerrarle el SELECT a esa tabla
-- NO rompe la función: se comprobó simulando este mismo cambio dentro de una
-- transacción, y para la agencia siguió devolviendo true y `trabajos_video`
-- siguió devolviendo sus filas.
--
-- Todo en una transacción: o quedan las cinco cerradas, o ninguna.
-- ============================================================================

begin;

  -- ia_jobs: la cola de pedidos a la IA. Prompts y respuestas de todos.
  drop policy if exists "equipo mira" on public.ia_jobs;
  drop policy if exists "equipo pide" on public.ia_jobs;
  create policy "agencia_ia_jobs_lee" on public.ia_jobs
    for select to authenticated
    using (public.mi_rol() = 'agencia');
  create policy "agencia_ia_jobs_pide" on public.ia_jobs
    for insert to authenticated
    with check (public.mi_rol() = 'agencia');

  -- lp_eventos: solo el SELECT. El INSERT anónimo se deja intacto a propósito:
  -- es el snippet de tracking que corre sin sesión en las landings de GHL.
  drop policy if exists "tracker lee" on public.lp_eventos;
  create policy "agencia_lp_eventos_lee" on public.lp_eventos
    for select to authenticated
    using (public.mi_rol() = 'agencia');

  -- equipo_video: expone los mails del equipo.
  drop policy if exists "el equipo se ve" on public.equipo_video;
  create policy "agencia_equipo_video" on public.equipo_video
    for select to authenticated
    using (public.mi_rol() = 'agencia');

  -- ejemplos_edicion: el rol de agencia se suma a lo que ya pedían. El
  -- alcance interno -cada uno lo suyo, el equipo ve todo- no cambia.
  drop policy if exists "crea sus ejemplos"          on public.ejemplos_edicion;
  drop policy if exists "borra sus ejemplos"         on public.ejemplos_edicion;
  drop policy if exists "el equipo ve los ejemplos"  on public.ejemplos_edicion;
  drop policy if exists "cambia sus ejemplos"        on public.ejemplos_edicion;
  create policy "agencia_ejemplos_crea" on public.ejemplos_edicion
    for insert to authenticated
    with check (public.mi_rol() = 'agencia' and auth.uid() = usuario_id);
  create policy "agencia_ejemplos_ve" on public.ejemplos_edicion
    for select to authenticated
    using (public.mi_rol() = 'agencia' and (auth.uid() = usuario_id or public.es_del_equipo()));
  create policy "agencia_ejemplos_cambia" on public.ejemplos_edicion
    for update to authenticated
    using      (public.mi_rol() = 'agencia' and auth.uid() = usuario_id)
    with check (public.mi_rol() = 'agencia' and auth.uid() = usuario_id);
  create policy "agencia_ejemplos_borra" on public.ejemplos_edicion
    for delete to authenticated
    using (public.mi_rol() = 'agencia' and auth.uid() = usuario_id);

  -- trabajos_video: igual. No hay policy de update para el estado y la salida,
  -- que los escribe solo el worker con service_role.
  drop policy if exists "usuario crea sus trabajos"  on public.trabajos_video;
  drop policy if exists "el equipo ve los trabajos"  on public.trabajos_video;
  drop policy if exists "el equipo borra trabajos"   on public.trabajos_video;
  drop policy if exists "el equipo etiqueta trabajos" on public.trabajos_video;
  create policy "agencia_trabajos_crea" on public.trabajos_video
    for insert to authenticated
    with check (public.mi_rol() = 'agencia' and auth.uid() = usuario_id);
  create policy "agencia_trabajos_ve" on public.trabajos_video
    for select to authenticated
    using (public.mi_rol() = 'agencia' and (auth.uid() = usuario_id or public.es_del_equipo()));
  create policy "agencia_trabajos_etiqueta" on public.trabajos_video
    for update to authenticated
    using      (public.mi_rol() = 'agencia' and (auth.uid() = usuario_id or public.es_del_equipo()))
    with check (public.mi_rol() = 'agencia' and (auth.uid() = usuario_id or public.es_del_equipo()));
  create policy "agencia_trabajos_borra" on public.trabajos_video
    for delete to authenticated
    using (public.mi_rol() = 'agencia' and (auth.uid() = usuario_id or public.es_del_equipo()));

commit;


-- ── Vuelta atrás (deja todo igual que antes de esta migración) ──────────────
/*
begin;
  drop policy if exists "agencia_ia_jobs_lee"        on public.ia_jobs;
  drop policy if exists "agencia_ia_jobs_pide"       on public.ia_jobs;
  create policy "equipo mira" on public.ia_jobs
    for select to authenticated using (true);
  create policy "equipo pide" on public.ia_jobs
    for insert to authenticated with check (true);

  drop policy if exists "agencia_lp_eventos_lee"     on public.lp_eventos;
  create policy "tracker lee" on public.lp_eventos
    for select to authenticated using (true);

  drop policy if exists "agencia_equipo_video"       on public.equipo_video;
  create policy "el equipo se ve" on public.equipo_video
    for select using (true);

  drop policy if exists "agencia_ejemplos_crea"      on public.ejemplos_edicion;
  drop policy if exists "agencia_ejemplos_ve"        on public.ejemplos_edicion;
  drop policy if exists "agencia_ejemplos_cambia"    on public.ejemplos_edicion;
  drop policy if exists "agencia_ejemplos_borra"     on public.ejemplos_edicion;
  create policy "crea sus ejemplos" on public.ejemplos_edicion
    for insert with check (auth.uid() = usuario_id);
  create policy "el equipo ve los ejemplos" on public.ejemplos_edicion
    for select using (auth.uid() = usuario_id or public.es_del_equipo());
  create policy "cambia sus ejemplos" on public.ejemplos_edicion
    for update using (auth.uid() = usuario_id) with check (auth.uid() = usuario_id);
  create policy "borra sus ejemplos" on public.ejemplos_edicion
    for delete using (auth.uid() = usuario_id);

  drop policy if exists "agencia_trabajos_crea"      on public.trabajos_video;
  drop policy if exists "agencia_trabajos_ve"        on public.trabajos_video;
  drop policy if exists "agencia_trabajos_etiqueta"  on public.trabajos_video;
  drop policy if exists "agencia_trabajos_borra"     on public.trabajos_video;
  create policy "usuario crea sus trabajos" on public.trabajos_video
    for insert with check (auth.uid() = usuario_id);
  create policy "el equipo ve los trabajos" on public.trabajos_video
    for select using (auth.uid() = usuario_id or public.es_del_equipo());
  create policy "el equipo etiqueta trabajos" on public.trabajos_video
    for update using (auth.uid() = usuario_id or public.es_del_equipo())
             with check (auth.uid() = usuario_id or public.es_del_equipo());
  create policy "el equipo borra trabajos" on public.trabajos_video
    for delete using (auth.uid() = usuario_id or public.es_del_equipo());
commit;
*/

-- NOTA lp_eventos: el INSERT anónimo sigue abierto, y es a propósito. Está
-- explicado en LIMPIEZA.md, sección "Sabido y aceptado".
--
-- NOTA PORTAL: cuando el portal tenga que mostrarle al cliente SUS eventos de
-- landing, no se afloja este select: se agrega una policy aparte con
-- `cliente = public.mi_cliente()`.
