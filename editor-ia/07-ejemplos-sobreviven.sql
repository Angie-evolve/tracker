-- ============================================================
--  Que los ejemplos sobrevivan al borrado del trabajo
--
--  Supabase -> SQL Editor -> New query -> pegar todo -> Run.
--
--  El banco de ejemplos colgaba del trabajo con ON DELETE CASCADE: borrar un
--  trabajo para liberar espacio se llevaba tambien las correcciones. Es al
--  reves de lo que hace falta. Un video son decenas de MB y se puede volver a
--  grabar; un ejemplo son 200 bytes de texto y es irrepetible, porque es la
--  unica vez que alguien se sento a decir donde el corte estuvo mal.
--
--  Con SET NULL el ejemplo queda huerfano de trabajo y sigue sirviendo: lo que
--  lo hace util es el texto, el veredicto y el estilo, no el video.
-- ============================================================

do $$
declare nombre text;
begin
  -- Se busca por columna y no por nombre: el nombre por defecto puede variar
  -- segun como se creo la tabla, y un drop a ciegas falla o borra otra cosa.
  select con.conname into nombre
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum   = con.conkey[1]
   where con.conrelid = 'ejemplos_edicion'::regclass
     and con.contype  = 'f'
     and array_length(con.conkey, 1) = 1
     and att.attname  = 'trabajo_id';

  if nombre is not null then
    execute format('alter table ejemplos_edicion drop constraint %I', nombre);
  end if;
end $$;

alter table ejemplos_edicion
  add constraint ejemplos_edicion_trabajo_id_fkey
  foreign key (trabajo_id) references trabajos_video(id) on delete set null;

-- Para comprobar que quedo bien. Tiene que decir 'n', que en pg_constraint es
-- SET NULL. Si dice 'c' es CASCADE y no se aplico.
select con.conname, con.confdeltype as al_borrar
  from pg_constraint con
  join pg_attribute att
    on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
 where con.conrelid = 'ejemplos_edicion'::regclass
   and con.contype = 'f'
   and att.attname = 'trabajo_id';
