create table if not exists tally_inventory_vouchers (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete restrict,
  import_batch_code text not null,
  product_id integer not null references products(id) on delete restrict,
  item_title text not null,
  voucher_number text,
  voucher_type text not null,
  voucher_date date not null,
  qty_in numeric(18, 4) not null default 0,
  qty_out numeric(18, 4) not null default 0,
  qty_signed numeric(18, 4) not null,
  unit_cost_base numeric(18, 4),
  value_signed_base numeric(18, 2),
  closing_qty numeric(18, 4),
  uom text,
  narration text,
  source_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint tally_inventory_vouchers_fingerprint_unique unique (company_id, source_fingerprint)
);

create index if not exists idx_tally_inventory_vouchers_company_product
  on tally_inventory_vouchers (company_id, product_id, voucher_date);

create index if not exists idx_tally_inventory_vouchers_number
  on tally_inventory_vouchers (company_id, voucher_number);

comment on table tally_inventory_vouchers is
  'Tally stock voucher lines ingested from Inventory.xml; stock_movements.ref_id points here for TALLY_* ref types.';
