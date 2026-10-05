create table if not exists approval_policies (
  id serial primary key,
  doc_type text not null,
  level_no integer not null,
  role_id integer references roles(id) on delete set null,
  group_id integer references user_groups(id) on delete set null,
  vendor_id integer references vendors(id) on delete set null,
  min_amount numeric(18, 2) not null default 0,
  max_amount numeric(18, 2),
  remarks text,
  is_active boolean not null default true,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (doc_type in ('purchase_order', 'goods_receipt', 'purchase_invoice', 'vendor_payment')),
  check (level_no > 0),
  check (role_id is not null or group_id is not null),
  check (max_amount is null or max_amount >= min_amount)
);

create index if not exists idx_approval_policies_doc_type on approval_policies(doc_type, is_active, level_no);
create index if not exists idx_approval_policies_role_id on approval_policies(role_id);
create index if not exists idx_approval_policies_group_id on approval_policies(group_id);
create index if not exists idx_approval_policies_vendor_id on approval_policies(vendor_id);

create table if not exists approval_action_history (
  id serial primary key,
  doc_type text not null,
  doc_id integer not null,
  action text not null,
  action_level integer not null default 0,
  policy_id integer references approval_policies(id) on delete set null,
  remarks text,
  acted_by integer references erp_users(id) on delete set null,
  acted_at timestamptz not null default now(),
  check (doc_type in ('purchase_order', 'goods_receipt', 'purchase_invoice', 'vendor_payment')),
  check (action in ('submitted', 'approved', 'sent_back', 'posted'))
);

create index if not exists idx_approval_action_history_doc on approval_action_history(doc_type, doc_id, acted_at desc);

alter table purchase_orders
add column if not exists current_approval_level integer not null default 0,
add column if not exists required_approval_level integer not null default 0;

alter table goods_receipts
add column if not exists current_approval_level integer not null default 0,
add column if not exists required_approval_level integer not null default 0;

alter table purchase_invoices
add column if not exists current_approval_level integer not null default 0,
add column if not exists required_approval_level integer not null default 0;

alter table vendor_payments
add column if not exists current_approval_level integer not null default 0,
add column if not exists required_approval_level integer not null default 0;
