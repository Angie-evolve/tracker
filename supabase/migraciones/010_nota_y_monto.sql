-- ============================================================================
-- 010_nota_y_monto.sql
--
-- QUE ARREGLA — dos huecos del portal, con la misma raiz:
--
--   1. EL MONTO SOLO SE PUEDE CARGAR AL MARCAR "Compró".
--      `pide_monto` esta en true en una sola etapa. Si el cliente cotiza en
--      "Presentación programada" o en "Tomando decisión", no tiene donde
--      anotarlo. Y una cotizacion que todavia no cerro es justamente el numero
--      que sirve para saber cuanto hay en juego.
--
--   2. LA NOTA NO TIENE PUERTA.
--      La columna existe desde el 005 y no hay forma de escribirla:
--      `lead_etapa` no la toca, y `lead_marcar` si pero ademas escribe
--      `estado`, que es la columna de GHL y la pisa el proximo sync. Mandar al
--      cliente por esa puerta seria darle una que le borra lo que hizo.
--
-- LA SOLUCION: una funcion nueva, `lead_datos`, que toca DOS columnas y nada
-- mas. Ni el nombre, ni el telefono, ni la etapa, ni el estado: no aparecen en
-- su update, asi que no puede tocarlos aunque quiera.
--
-- POR QUE UNA FUNCION NUEVA Y NO AMPLIAR `lead_etapa`:
-- Son dos gestos distintos. Mover de etapa es un cambio de estado del lead;
-- anotar una nota o una cotizacion no lo mueve. Mezclarlos obligaria a mandar
-- la etapa actual cada vez que se escribe una nota, y un error ahi mueve el
-- lead sin querer.
--
-- TODO ES ADITIVO. Una funcion nueva. Ninguna columna, ninguna policy.
-- ============================================================================

begin;

create or replace function public.lead_datos(
  p_lead_id uuid,
  p_nota    text    default null,
  p_monto   numeric default null,
  -- Para poder BORRAR. Sin esto, mandar null significa "no lo toques" y no hay
  -- forma de vaciar una nota escrita por error.
  p_borrar_nota  boolean default false,
  p_borrar_monto boolean default false
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_lead_cli text; v_es_agencia boolean; v_cliente text;
begin
  v_es_agencia := public.es_agencia();          -- nunca NULL
  v_cliente    := public.mi_cliente();

  select cliente_id into v_lead_cli from public.leads where id = p_lead_id;

  -- Mismo mensaje exista o no: no le confirmamos a nadie que un lead ajeno
  -- esta ahi. Igual que en lead_etapa.
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
         -- Se reusan las columnas de auditoria de la etapa: son "quien toco
         -- este lead por ultima vez y cuando", no "quien lo movio de etapa".
         etapa_at  = now(),
         etapa_por = auth.uid()
   where id = p_lead_id;
end $$;

revoke all     on function public.lead_datos(uuid, text, numeric, boolean, boolean) from public, anon;
grant  execute on function public.lead_datos(uuid, text, numeric, boolean, boolean) to authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR — se mira a ojo. Cada bloque termina en rollback.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Existe, es security definer, y anon no llega.
select p.proname,
       pg_get_function_identity_arguments(p.oid)                 as args,
       p.prosecdef                                               as security_definer,
       has_function_privilege('anon',          p.oid, 'execute')  as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute')  as logueado_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'lead_datos';

-- ⚠️  anon_puede = false.


-- 2. Que escriba la nota y el monto, y que NO toque nada mas.
begin;
  select id, nombre, telefono, etapa_portal, estado, nota, monto
    from public.leads limit 1;

  select public.lead_datos(
    (select id from public.leads limit 1),
    'Cotizado por 3 meses', 450000);

  select nombre, telefono, etapa_portal, estado, nota, monto
    from public.leads limit 1;
rollback;

-- ⚠️  nota y monto cambian. nombre, telefono, etapa_portal y estado quedan
--     EXACTAMENTE iguales.


-- 3. Que un cliente no pueda escribirle a un lead ajeno.
--    (hacerse pasar por el cliente de prueba y apuntarle a otro lead)
-- ⚠️  Tiene que decir "Ese lead no existe".


-- ════════════════════════════════════════════════════════════════════════════
-- PENDIENTE DEL PORTAL — esto es zona CLIENTE, va aparte
-- ════════════════════════════════════════════════════════════════════════════
--
-- La funcion sola no alcanza: el portal no tiene donde escribir. Hace falta
--   - un campo de nota en la tarjeta (o en la hoja que ya se abre)
--   - poder cargar el monto en cualquier etapa, no solo al marcar "Compró"
--
-- Sobre `pide_monto`: se deja como esta. Sirve para OFRECER el monto sin que
-- lo pidan -al marcar "Compró" conviene preguntarlo-, pero deja de ser la
-- unica via: con `lead_datos` se puede cargar siempre.
--
-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
drop function if exists public.lead_datos(uuid, text, numeric, boolean, boolean);
*/
-- ============================================================================
