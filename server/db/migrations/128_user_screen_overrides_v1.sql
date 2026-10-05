create table if not exists user_screen_permissions (
  id bigserial primary key,
  user_id int not null references erp_users(id) on delete cascade,
  screen_key text not null,
  can_view boolean,
  can_create boolean,
  can_edit boolean,
  can_approve boolean,
  own_records_only boolean,
  financial_masking boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, screen_key)
);

create index if not exists idx_user_screen_permissions_user_id
  on user_screen_permissions(user_id);

create index if not exists idx_user_screen_permissions_screen_key
  on user_screen_permissions(screen_key);
