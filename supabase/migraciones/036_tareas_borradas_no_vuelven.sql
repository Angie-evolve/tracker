-- 036 · Un ticket eliminado no vuelve porque una pestaña vieja lo suba
--
-- POR QUE (Angie, 14/10/2026)
-- Los tickets eliminados volvian a aparecer. La app sube `datos` entero desde
-- la memoria de cada pestaña, y una pestaña abierta desde antes de eliminar
-- -o con codigo viejo, que no se recargo- tiene esos tickets sin la marca y
-- los vuelve a subir. El 14/10 se eliminaron 33 y en minutos volvieron 21,
-- con todos los clientes guardandose cada pocos segundos.
--
-- El arreglo en la app (_cliEditarEnNube) solo protege a las pestañas que ya
-- tienen el codigo nuevo. Esto lo hace la base, para todas:
--   si un ticket esta eliminado (`deleted: true`) y la version que llega lo
--   trae sin la marca, se le vuelve a poner la marca, con su fecha y motivo.
--
-- RESTAURAR SIGUE ANDANDO: el boton "Restaurar" de la app deja `restauradoAt`
-- con la hora. Si es posterior a `deletedAt`, se respeta y el ticket vuelve.
--
-- No agrega tickets que la version nueva no traiga: solo cuida la marca de
-- los que vienen.

create or replace function public.tareas_borradas_no_vuelven()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_borradas jsonb;
  v_out jsonb := '[]'::jsonb;
  v_t jsonb;
  v_o jsonb;
begin
  if OLD.datos is null or NEW.datos is null
     or jsonb_typeof(OLD.datos->'tasks') is distinct from 'array'
     or jsonb_typeof(NEW.datos->'tasks') is distinct from 'array' then
    return NEW;
  end if;

  select coalesce(jsonb_object_agg(t->>'id', t), '{}'::jsonb) into v_borradas
    from jsonb_array_elements(OLD.datos->'tasks') t
   where jsonb_typeof(t) = 'object' and t ? 'id'
     and lower(coalesce(t->>'deleted', '')) in ('true', '1');

  if v_borradas = '{}'::jsonb then
    return NEW;
  end if;

  for v_t in select * from jsonb_array_elements(NEW.datos->'tasks') loop
    if jsonb_typeof(v_t) = 'object' then
      v_o := v_borradas -> (v_t->>'id');
      if v_o is not null
         and lower(coalesce(v_t->>'deleted', '')) not in ('true', '1')
         and coalesce(v_t->>'restauradoAt', '') <= coalesce(v_o->>'deletedAt', '') then
        v_t := v_t || jsonb_build_object('deleted', true)
                   || jsonb_strip_nulls(jsonb_build_object('deletedAt', v_o->'deletedAt',
                                                           'motivoBorrado', v_o->'motivoBorrado'));
      end if;
    end if;
    v_out := v_out || jsonb_build_array(v_t);
  end loop;

  NEW.datos := jsonb_set(NEW.datos, '{tasks}', v_out);
  return NEW;
end;
$$;

drop trigger if exists clientes_tareas_borradas on public.clientes;
create trigger clientes_tareas_borradas
  before update of datos on public.clientes
  for each row execute function public.tareas_borradas_no_vuelven();

-- COMO SE VUELVE ATRAS
--   drop trigger if exists clientes_tareas_borradas on public.clientes;
--   drop function if exists public.tareas_borradas_no_vuelven();
--   No cambia ningun dato que ya este guardado: solo actua en los UPDATE.
