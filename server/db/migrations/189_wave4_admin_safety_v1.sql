-- 189: Wave 4 admin safety — honest backup status, go-live checklist, product merge marker, data ops screen

-- Allow metadata-only backup rows (no fabricated DR dump)
alter table system_backups drop constraint if exists system_backups_status_check;
alter table system_backups
  add constraint system_backups_status_check
  check (status in ('completed', 'in_progress', 'failed', 'scheduled', 'metadata_only'));

alter table products
  add column if not exists merged_into_product_id integer references products(id) on delete set null;

create index if not exists idx_products_merged_into
  on products(merged_into_product_id)
  where merged_into_product_id is not null;

-- Server-persisted go-live checklist (replaces browser-only localStorage as source of truth)
create table if not exists go_live_checklist_state (
  checklist_key text primary key default 'absstem_pilot_v1',
  items_json jsonb not null default '{}'::jsonb,
  updated_by integer references erp_users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists data_ops_runs (
  id bigserial primary key,
  company_id bigint references companies(id) on delete set null,
  op_key text not null,
  mode text not null default 'dry_run', -- dry_run | apply
  confirm_phrase text,
  request_payload jsonb,
  result_payload jsonb,
  status text not null default 'ok',
  actor_id integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint data_ops_runs_mode_check check (mode in ('dry_run', 'apply')),
  constraint data_ops_runs_status_check check (status in ('ok', 'failed'))
);

create index if not exists idx_data_ops_runs_created
  on data_ops_runs(created_at desc);

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  r.id,
  'data_ops',
  true,
  r.role_key in ('super_admin'),
  r.role_key in ('super_admin'),
  r.role_key in ('super_admin'),
  false,
  false
from roles r
where r.role_key in ('super_admin')
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
  r.id,
  'lead_ingestion',
  true,
  r.role_key in ('super_admin', 'business_admin', 'marketing_manager', 'sales_manager'),
  r.role_key in ('super_admin', 'business_admin', 'marketing_manager'),
  r.role_key in ('super_admin', 'business_admin'),
  false,
  false
from roles r
where r.role_key in ('super_admin', 'business_admin', 'marketing_manager', 'sales_manager')
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;
