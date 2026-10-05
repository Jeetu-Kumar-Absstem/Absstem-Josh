-- ERP-gated Google Drive registry (zero-trust proxy; no client-held Drive URLs)

create table if not exists drive_files (
  id bigserial primary key,
  drive_file_id text not null,
  category text not null,
  file_name text not null,
  mime_type text,
  file_size_bytes bigint,
  company_id bigint references companies(id) on delete set null,
  product_id bigint references products(id) on delete set null,
  owner_ref text,
  uploaded_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint drive_files_drive_file_id_key unique (drive_file_id),
  constraint drive_files_category_check check (
    category in ('statutory', 'model_asset', 'marketing_collateral', 'service_amc')
  )
);

create index if not exists drive_files_category_active_idx
  on drive_files (category)
  where deleted_at is null;

create index if not exists drive_files_company_category_idx
  on drive_files (company_id, category)
  where deleted_at is null;

create index if not exists drive_files_product_category_idx
  on drive_files (product_id, category)
  where deleted_at is null;
