-- ============================================================
--  Avisarle a GitHub apenas entra un trabajo
--
--  El cron dice cada 10 minutos pero GitHub estrangula los workflows
--  programados: medido en este repo, corrio 17:09, 19:17, 21:28, 23:13. Cada
--  dos horas. Con esto el runner arranca a los segundos de subir el video, y el
--  cron queda de red de seguridad por si el aviso no sale.
--
--  El token vive en Vault, cifrado. No esta en ninguna tabla que la app pueda
--  leer ni en el codigo del repo, que es publico.
-- ============================================================

create extension if not exists pg_net with schema extensions;

create or replace function avisar_a_github()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  tok text;
begin
  select decrypted_secret into tok
    from vault.decrypted_secrets
   where name = 'github_actions_token'
   limit 1;

  -- Sin token no pasa nada y no se rompe nada: el cron lo va a levantar igual,
  -- solo que mas tarde.
  if tok is null or tok = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Angie-evolve/tracker/actions/workflows/'
           || 'editor-ia-worker.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept',        'application/vnd.github+json',
      'User-Agent',    'evolve-tracker',
      'Content-Type',  'application/json')
  );
  return new;
exception when others then
  -- Que el aviso falle no puede impedir que el trabajo se guarde. Perder el
  -- video subido por un problema de red con GitHub seria mucho peor que
  -- esperar al cron.
  return new;
end;
$$;

drop trigger if exists trabajos_video_avisar on trabajos_video;

create trigger trabajos_video_avisar
  after insert on trabajos_video
  for each row
  when (new.estado = 'pendiente')
  execute function avisar_a_github();
