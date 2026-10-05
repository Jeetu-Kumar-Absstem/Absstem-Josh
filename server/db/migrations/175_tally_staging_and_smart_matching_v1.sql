-- 175: AI-Assisted Staging & Smart Auto-Matching for Tally Ingestion (Phase 14)

-- 1. Isolated Staging Area for raw Tally records before live ingestion
create table if not exists tally_staging_area (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  batch_id bigint references tally_import_logs(id) on delete cascade,
  record_type text not null, -- 'ledger', 'stock_item', 'voucher'
  source_identifier text not null, -- ledger name, stock item name, or voucher number
  raw_payload jsonb not null default '{}'::jsonb,
  
  -- Matching Diagnostics & Confidence Scoring
  match_strategy text not null default 'pending', -- 'deterministic_gstin', 'deterministic_pan', 'fuzzy_name', 'voucher_amount_seq', 'new_record', 'unmatched'
  match_confidence_pct numeric(5, 2) not null default 0.00,
  suggested_target_table text, -- 'customers', 'vendors', 'products', 'chart_of_accounts', 'customer_invoices', 'receipts', 'vendor_bills'
  suggested_target_id bigint,
  suggested_target_display text,
  
  -- Action & Review Status
  resolution_status text not null default 'AUTO_MATCHED', -- 'AUTO_MATCHED', 'NEEDS_REVIEW', 'APPROVED', 'OVERRIDDEN', 'COMMITTED', 'DISCARDED'
  ai_recommendation jsonb not null default '{}'::jsonb,
  review_notes text,
  user_override_target_id bigint,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tally_staging_record_type_check check (
    record_type in ('ledger', 'stock_item', 'voucher')
  ),
  constraint tally_staging_resolution_check check (
    resolution_status in ('AUTO_MATCHED', 'NEEDS_REVIEW', 'APPROVED', 'OVERRIDDEN', 'COMMITTED', 'DISCARDED')
  )
);

create index if not exists idx_tally_staging_batch_company
  on tally_staging_area(company_id, batch_id);

create index if not exists idx_tally_staging_status
  on tally_staging_area(batch_id, resolution_status);

create index if not exists idx_tally_staging_record_type
  on tally_staging_area(batch_id, record_type);

-- 2. Add staged status to tally_import_logs
do $$
begin
  alter table tally_import_logs
    drop constraint if exists tally_import_logs_status_check;
  
  alter table tally_import_logs
    add constraint tally_import_logs_status_check
    check (status in ('pending', 'processing', 'staged', 'completed', 'partial_error', 'failed'));
end $$;

-- 3. Screen permissions update for staging workflow
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  r.id,
  'tally_import_desk',
  true,
  true,
  true,
  r.role_key in ('super_admin', 'business_admin', 'finance_head'),
  false,
  false
from roles r
where r.role_key in ('super_admin', 'business_admin', 'finance_head', 'accounts_manager')
on conflict (role_id, screen_key) do update
set
  can_view = true,
  can_create = true,
  can_edit = true,
  can_approve = excluded.can_approve;

comment on table tally_staging_area is 'Isolated staging schema holding Tally masters and vouchers for deterministic, fuzzy matching, and AI-assisted exception resolution prior to live ERP commit';
