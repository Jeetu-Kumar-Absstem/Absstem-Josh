-- 171: System Administration, Security Audit Trails & Backup Governance (Phase 11)

-- 1. Comprehensive Audit Logs Table
create table if not exists audit_logs (
  id bigserial primary key,
  company_id bigint references companies(id) on delete set null,
  actor_id integer references erp_users(id) on delete set null,
  actor_email text,
  actor_name text,
  action_type text not null, -- 'CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'LOGIN', 'LOGOUT', 'EXPORT', 'BACKUP_TRIGGER', 'ROLE_CHANGE', 'BOM_LOCK', 'GL_POST', 'INVOICE_GENERATE', 'STOCK_ADJUST'
  module text not null default 'GENERAL', -- 'SYSTEM_ADMIN', 'MANUFACTURING', 'PURCHASE', 'SALES', 'FINANCE', 'SERVICE', 'MRP', 'INVENTORY', 'AUTH'
  target_table text,
  target_id text,
  old_payload jsonb,
  new_payload jsonb,
  ip_address text,
  user_agent text,
  status text not null default 'success', -- 'success', 'failed', 'warning'
  remarks text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_company_created
  on audit_logs(company_id, created_at desc);

create index if not exists idx_audit_logs_module_created
  on audit_logs(module, created_at desc);

create index if not exists idx_audit_logs_actor
  on audit_logs(actor_id, created_at desc);

create index if not exists idx_audit_logs_target
  on audit_logs(target_table, target_id);

-- 2. System Backups & Snapshot Logs Table
create table if not exists system_backups (
  id bigserial primary key,
  company_id bigint references companies(id) on delete set null,
  backup_code text not null,
  backup_type text not null default 'automated', -- 'automated', 'manual', 'schema_only', 'full_data'
  storage_destination text not null default 'local_vps', -- 'local_vps', 'google_drive', 'hybrid_cloud'
  file_path text,
  file_name text not null,
  file_size_bytes bigint not null default 0,
  file_size_display text,
  tables_included_count integer default 0,
  records_backed_up bigint default 0,
  duration_seconds numeric(8, 2) default 0,
  status text not null default 'completed', -- 'completed', 'in_progress', 'failed', 'scheduled'
  error_message text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint system_backups_status_check check (status in ('completed', 'in_progress', 'failed', 'scheduled')),
  constraint system_backups_dest_check check (storage_destination in ('local_vps', 'google_drive', 'hybrid_cloud'))
);

create index if not exists idx_system_backups_created
  on system_backups(created_at desc);

-- 3. Screen permissions for admin_desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'admin_desk', true, true, true, true, false, false
from roles r
where r.role_key in ('super_admin', 'management', 'executive', 'cfo', 'ceo')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true, can_approve = true;
