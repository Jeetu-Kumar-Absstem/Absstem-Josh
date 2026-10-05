-- Phase 2: Corporate office layer — IT assets, plant visitors, skill matrices, HR transitions

-- ---------------------------------------------------------------------------
-- 1) Office / IT hardware assets
-- ---------------------------------------------------------------------------
create table if not exists office_assets (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  asset_tag text not null,
  category text not null,
  status text not null default 'Available',
  assigned_user_id integer references erp_users(id) on delete set null,
  purchase_date date,
  notes text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint office_assets_asset_tag_key unique (asset_tag),
  constraint office_assets_category_check check (
    category in ('Laptop', 'Phone', 'Keys', 'Monitor', 'Peripheral', 'Access_Card', 'Other')
  ),
  constraint office_assets_status_check check (
    status in ('Available', 'Assigned', 'Under_Repair', 'Retired')
  ),
  constraint office_assets_assigned_consistency check (
    (status = 'Assigned' and assigned_user_id is not null)
    or (status in ('Available', 'Retired') and assigned_user_id is null)
    or (status = 'Under_Repair')
  )
);

create index if not exists office_assets_status_idx on office_assets (status);
create index if not exists office_assets_assigned_user_idx on office_assets (assigned_user_id);
create index if not exists office_assets_company_idx on office_assets (company_id);

-- ---------------------------------------------------------------------------
-- 2) Plant / facility visitor logs
-- ---------------------------------------------------------------------------
create table if not exists plant_visitor_logs (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  visitor_name text not null,
  representing_company text,
  purpose text,
  host_user_id integer references erp_users(id) on delete set null,
  check_in_time timestamptz not null default now(),
  check_out_time timestamptz,
  status text not null default 'Active',
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plant_visitor_logs_status_check check (status in ('Active', 'Completed')),
  constraint plant_visitor_logs_checkout_consistency check (
    (status = 'Active' and check_out_time is null)
    or (status = 'Completed' and check_out_time is not null)
  )
);

create index if not exists plant_visitor_logs_status_idx on plant_visitor_logs (status);
create index if not exists plant_visitor_logs_host_idx on plant_visitor_logs (host_user_id);
create index if not exists plant_visitor_logs_check_in_idx on plant_visitor_logs (check_in_time desc);

-- ---------------------------------------------------------------------------
-- 3) HR skill matrices (engineering / field qualification)
-- ---------------------------------------------------------------------------
create table if not exists hr_skill_matrices (
  id bigserial primary key,
  user_id integer not null references erp_users(id) on delete cascade,
  skill_category text not null,
  certification_level text not null default 'Trained',
  last_evaluated_date date,
  notes text,
  evaluated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_skill_matrices_user_skill_key unique (user_id, skill_category),
  constraint hr_skill_matrices_level_check check (
    certification_level in ('Aware', 'Trained', 'Competent', 'Expert', 'Assessor')
  )
);

create index if not exists hr_skill_matrices_user_idx on hr_skill_matrices (user_id);
create index if not exists hr_skill_matrices_category_idx on hr_skill_matrices (skill_category);

-- ---------------------------------------------------------------------------
-- 4) HR rights delegation audit
-- ---------------------------------------------------------------------------
create table if not exists hr_rights_delegations (
  id bigserial primary key,
  from_user_id integer not null references erp_users(id) on delete restrict,
  to_user_id integer not null references erp_users(id) on delete restrict,
  modules jsonb not null default '[]'::jsonb,
  screen_keys jsonb not null default '[]'::jsonb,
  performed_by integer not null references erp_users(id) on delete restrict,
  notes text,
  created_at timestamptz not null default now(),
  constraint hr_rights_delegations_distinct_users check (from_user_id <> to_user_id)
);

create index if not exists hr_rights_delegations_from_idx on hr_rights_delegations (from_user_id);
create index if not exists hr_rights_delegations_to_idx on hr_rights_delegations (to_user_id);

create table if not exists hr_offboarding_alerts (
  id bigserial primary key,
  offboarded_user_id integer not null references erp_users(id) on delete cascade,
  alert_type text not null,
  message text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists hr_offboarding_alerts_open_idx
  on hr_offboarding_alerts (offboarded_user_id)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 5) Screen permissions
-- ---------------------------------------------------------------------------
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  'hr_admin',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'hr_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  'office_admin',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'hr_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;
