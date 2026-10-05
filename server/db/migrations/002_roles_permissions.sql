create table if not exists erp_modules (
  id serial primary key,
  module_key text not null unique,
  module_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists user_groups (
  id serial primary key,
  group_name text not null unique,
  max_autonomous_discount_pct numeric(5, 2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  id serial primary key,
  role_key text not null unique,
  role_name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists erp_users (
  id serial primary key,
  email citext not null unique,
  full_name text,
  group_id integer not null references user_groups(id),
  primary_role_id integer references roles(id),
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_erp_users_group_id on erp_users(group_id);
create index if not exists idx_erp_users_primary_role_id on erp_users(primary_role_id);

create table if not exists user_roles (
  id serial primary key,
  user_id integer not null references erp_users(id) on delete cascade,
  role_id integer not null references roles(id) on delete cascade,
  is_primary boolean not null default false,
  assigned_by integer references erp_users(id),
  assigned_at timestamptz not null default now(),
  unique (user_id, role_id)
);

create index if not exists idx_user_roles_user_id on user_roles(user_id);
create index if not exists idx_user_roles_role_id on user_roles(role_id);

create table if not exists role_module_permissions (
  id serial primary key,
  role_id integer not null references roles(id) on delete cascade,
  module_id integer not null references erp_modules(id) on delete cascade,
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_approve boolean not null default false,
  unique (role_id, module_id)
);

create index if not exists idx_role_module_permissions_role_id on role_module_permissions(role_id);
create index if not exists idx_role_module_permissions_module_id on role_module_permissions(module_id);

create table if not exists screen_permissions (
  id serial primary key,
  role_id integer not null references roles(id) on delete cascade,
  screen_key text not null,
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_approve boolean not null default false,
  own_records_only boolean not null default false,
  financial_masking boolean not null default false,
  unique (role_id, screen_key)
);

create index if not exists idx_screen_permissions_role_id on screen_permissions(role_id);
