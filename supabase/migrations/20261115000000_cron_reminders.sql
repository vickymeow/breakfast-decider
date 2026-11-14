-- 定时提醒：每 15 分钟调一次云函数的 /api/cron，由函数按家里的时区决定该不该发（每条每天只发一次）。
-- 换成自己的项目时，把下面 URL 里的 project ref 改掉（和 docs/config.js 里的一致）。
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'breakfast-reminders') then
    perform cron.unschedule('breakfast-reminders');
  end if;
end $$;

select cron.schedule(
  'breakfast-reminders',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := 'https://jnrceiwidetzijmdbczs.supabase.co/functions/v1/breakfast/api/cron',
      headers := '{"content-type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $cron$
);
