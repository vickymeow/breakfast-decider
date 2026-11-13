-- 早饭决定器：单行 JSON 状态（菜单 + 当天选择）。
-- 只由 breakfast 云函数用 service role 读写；不给 anon / authenticated 任何策略。
create table if not exists public.breakfast_state (
  id integer primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.breakfast_state enable row level security;

-- 菜的照片：公开读取的存储桶，上传只经过云函数。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('breakfast', 'breakfast', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
