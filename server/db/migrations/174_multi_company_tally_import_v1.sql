-- 174: Multi-Company Tally ERP Data Ingestion & Reconciliation Module (Phase 13)

-- 1. Multi-Company Tally Import Logs
create table if not exists tally_import_logs (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  import_batch_code text not null,
  entity_code text not null, -- 'AI' or 'AT'
  file_name text not null,
  file_format text not null default 'xml', -- 'xml' or 'json'
  file_size_bytes bigint not null default 0,
  masters_count integer not null default 0,
  vouchers_count integer not null default 0,
  ledgers_imported integer not null default 0,
  stock_items_imported integer not null default 0,
  vouchers_reconciled integer not null default 0,
  status text not null default 'completed', -- 'completed', 'partial_error', 'failed', 'processing'
  reconciliation_summary jsonb not null default '{}'::jsonb,
  error_message text,
  imported_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz default now(),
  constraint tally_import_logs_status_check check (
    status in ('pending', 'processing', 'completed', 'partial_error', 'failed')
  ),
  constraint tally_import_batch_unique unique (company_id, import_batch_code)
);

create index if not exists idx_tally_import_logs_company_created
  on tally_import_logs(company_id, created_at desc);

create index if not exists idx_tally_import_logs_entity
  on tally_import_logs(entity_code, created_at desc);

-- 2. Tally Master Mappings & Entity Partitioning
create table if not exists tally_master_mappings (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  master_type text not null, -- 'customer_ledger', 'vendor_ledger', 'stock_item', 'gl_account'
  tally_guid text,
  tally_name text not null,
  tally_parent_group text,
  target_table text not null, -- 'customers', 'vendors', 'products', 'chart_of_accounts'
  target_id bigint,
  match_status text not null default 'matched', -- 'matched', 'created', 'unmapped', 'conflict'
  opening_balance numeric(18, 2) not null default 0,
  opening_balance_type text not null default 'debit', -- 'debit', 'credit'
  closing_balance numeric(18, 2) not null default 0,
  raw_attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tally_master_mappings_type_check check (
    master_type in ('customer_ledger', 'vendor_ledger', 'stock_item', 'gl_account')
  ),
  constraint tally_master_mappings_unique unique (company_id, master_type, tally_name)
);

create index if not exists idx_tally_master_mappings_company_type
  on tally_master_mappings(company_id, master_type);

create index if not exists idx_tally_master_mappings_target
  on tally_master_mappings(target_table, target_id);

-- 3. Tally Voucher Reconciliations
create table if not exists tally_voucher_reconciliations (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  import_log_id bigint references tally_import_logs(id) on delete cascade,
  voucher_type text not null, -- 'Sales', 'Receipt', 'Payment', 'Journal', 'Purchase'
  voucher_number text not null,
  voucher_date date not null,
  party_name text,
  tally_amount numeric(18, 2) not null default 0,
  josh_amount numeric(18, 2) not null default 0,
  variance numeric(18, 2) not null default 0,
  reconciliation_status text not null default 'reconciled', -- 'reconciled', 'variance_detected', 'created_in_josh', 'missing_in_josh'
  matched_entity_type text, -- 'customer_invoices', 'receipts', 'vendor_bills', 'general_ledger_entries'
  matched_entity_id bigint,
  voucher_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tally_voucher_reconciliations_unique unique (company_id, voucher_type, voucher_number, voucher_date)
);

create index if not exists idx_tally_voucher_rec_company_date
  on tally_voucher_reconciliations(company_id, voucher_date desc);

create index if not exists idx_tally_voucher_rec_import_log
  on tally_voucher_reconciliations(import_log_id);

-- 4. Screen Permissions for Tally Import Desk
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  r.id,
  'tally_import_desk',
  true,
  r.role_key in ('super_admin', 'business_admin', 'finance_head', 'accounts_manager'),
  r.role_key in ('super_admin', 'business_admin', 'finance_head', 'accounts_manager'),
  r.role_key in ('super_admin', 'business_admin', 'finance_head'),
  false,
  false
from roles r
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

comment on table tally_import_logs is 'Multi-Company Tally backup XML/JSON ingestion run logs with reconciliation status per legal entity';
comment on table tally_master_mappings is 'Entity-scoped mapping dictionary linking Tally ledgers/stock items to Josh CRM, Vendors, Products & Chart of Accounts';
comment on table tally_voucher_reconciliations is 'Transactional audit and variance comparison between Tally vouchers and Josh ERP entries';
