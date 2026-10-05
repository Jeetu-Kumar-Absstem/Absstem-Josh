create table if not exists purchase_requisitions (
  id serial primary key,
  requisition_number text not null unique,
  requisition_status text not null default 'draft',
  requisition_date date not null default current_date,
  required_by_date date,
  department text,
  purpose text,
  remarks text,
  estimated_subtotal numeric(18, 2) not null default 0,
  estimated_tax_total numeric(18, 2) not null default 0,
  estimated_total numeric(18, 2) not null default 0,
  current_approval_level integer not null default 0,
  required_approval_level integer not null default 0,
  submitted_by integer references erp_users(id),
  submitted_at timestamptz,
  approved_by integer references erp_users(id),
  approved_at timestamptz,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requisition_status in ('draft', 'submitted', 'approved', 'closed', 'cancelled'))
);

create index if not exists idx_purchase_requisitions_created_by on purchase_requisitions(created_by);
create index if not exists idx_purchase_requisitions_status on purchase_requisitions(requisition_status);

create table if not exists purchase_requisition_lines (
  id serial primary key,
  purchase_requisition_id integer not null references purchase_requisitions(id) on delete cascade,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty_requested numeric(18, 4) not null default 1,
  estimated_unit_price numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_estimated numeric(18, 2) not null default 0,
  unique (purchase_requisition_id, line_no),
  check (qty_requested > 0)
);

create index if not exists idx_purchase_requisition_lines_requisition_id on purchase_requisition_lines(purchase_requisition_id);

alter table purchase_orders
add column if not exists purchase_requisition_id integer references purchase_requisitions(id) on delete set null;

alter table purchase_order_lines
add column if not exists purchase_requisition_line_id integer references purchase_requisition_lines(id) on delete set null;

create index if not exists idx_purchase_orders_requisition_id on purchase_orders(purchase_requisition_id);
create index if not exists idx_purchase_order_lines_requisition_line_id on purchase_order_lines(purchase_requisition_line_id);

alter table approval_policies drop constraint if exists approval_policies_doc_type_check;
alter table approval_policies
add constraint approval_policies_doc_type_check
check (doc_type in ('purchase_requisition', 'purchase_order', 'goods_receipt', 'purchase_invoice', 'vendor_payment'));

alter table approval_action_history drop constraint if exists approval_action_history_doc_type_check;
alter table approval_action_history
add constraint approval_action_history_doc_type_check
check (doc_type in ('purchase_requisition', 'purchase_order', 'goods_receipt', 'purchase_invoice', 'vendor_payment'));
