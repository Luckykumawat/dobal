-- Run in Supabase SQL Editor (Dobal project)
-- Tracks which Dot Workspace apps each Dot ID user has logged into,
-- powering the filtered 9-dot app switcher.

create table if not exists dot_user_apps (
  user_id uuid not null references auth.users(id) on delete cascade,
  app_id text not null,
  first_login_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  primary key (user_id, app_id)
);

alter table dot_user_apps enable row level security;

create policy "Users can view their own Dot apps"
  on dot_user_apps for select
  using (auth.uid() = user_id);
