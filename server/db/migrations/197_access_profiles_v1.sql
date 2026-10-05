-- Access redesign Phase 1: Access Profiles (roles) with module/screen level grants,
-- org-chart baseline rules, per-user overrides, and zero-difference verification runs.
-- Everything compiles down to the existing 6 screen flags; enforcement stays on the legacy
-- tables until ACCESS_MODEL_V2=on.

create table if not exists access_profile_grants (
  id bigserial primary key,
  role_id integer not null references roles(id) on delete cascade,
  module_key text,
  screen_key text,
  level text not null check (level in ('none', 'viewer', 'contributor', 'approver', 'custom')),
  scope text not null default 'all' check (scope in ('own', 'team', 'all')),
  can_view boolean,
  can_create boolean,
  can_edit boolean,
  can_approve boolean,
  own_records_only boolean,
  financial_masking boolean,
  source text not null default 'v2' check (source in ('legacy', 'v2')),
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint access_profile_grants_target_check check ((module_key is null) <> (screen_key is null)),
  constraint access_profile_grants_custom_check check (
    level <> 'custom'
    or (can_view is not null and can_create is not null and can_edit is not null
        and can_approve is not null and own_records_only is not null and financial_masking is not null)
  )
);

create unique index if not exists idx_access_profile_grants_module_uq
  on access_profile_grants (role_id, module_key) where module_key is not null;
create unique index if not exists idx_access_profile_grants_screen_uq
  on access_profile_grants (role_id, screen_key) where screen_key is not null;

create table if not exists access_baseline_rules (
  id bigserial primary key,
  company_id integer references companies(id) on delete cascade,
  department_key text references departments(department_key) on delete cascade,
  designation_name citext,
  suggested_role_id integer not null references roles(id) on delete cascade,
  priority integer not null default 100,
  is_active boolean not null default true,
  note text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint access_baseline_rules_match_check check (department_key is not null or designation_name is not null)
);

create unique index if not exists idx_access_baseline_rules_uq
  on access_baseline_rules (coalesce(company_id, 0), coalesce(department_key, ''), coalesce(designation_name, ''::citext))
  where is_active = true;

-- level 'custom' keeps per-flag tri-state (NULL = inherit), matching user_screen_permissions.
create table if not exists user_access_overrides (
  id bigserial primary key,
  user_id integer not null references erp_users(id) on delete cascade,
  screen_key text not null,
  level text not null check (level in ('none', 'viewer', 'contributor', 'approver', 'custom')),
  scope text not null default 'all' check (scope in ('own', 'team', 'all')),
  can_view boolean,
  can_create boolean,
  can_edit boolean,
  can_approve boolean,
  own_records_only boolean,
  financial_masking boolean,
  reason text not null,
  expires_at timestamptz,
  source text not null default 'v2' check (source in ('legacy', 'v2')),
  granted_by integer references erp_users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_user_access_overrides_active_uq
  on user_access_overrides (user_id, screen_key) where revoked_at is null;
create index if not exists idx_user_access_overrides_user
  on user_access_overrides (user_id) where revoked_at is null;

create table if not exists access_verification_runs (
  id bigserial primary key,
  run_kind text not null default 'verify' check (run_kind in ('backfill', 'verify')),
  users_checked integer not null default 0,
  screens_checked integer not null default 0,
  mismatch_users integer not null default 0,
  mismatch_count integer not null default 0,
  details jsonb not null default '[]'::jsonb,
  ran_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists access_permission_snapshots (
  id bigserial primary key,
  run_id bigint not null references access_verification_runs(id) on delete cascade,
  user_id integer not null references erp_users(id) on delete cascade,
  legacy_screens jsonb not null,
  compiled_screens jsonb not null,
  matches boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_access_permission_snapshots_run on access_permission_snapshots (run_id, matches);
