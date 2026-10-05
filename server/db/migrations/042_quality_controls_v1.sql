create table if not exists quality_controls (
  id serial primary key,
  qc_number text not null unique,
  goods_receipt_id integer not null references goods_receipts(id) on delete cascade,
  qc_status text not null default 'draft',
  inspection_date date not null default current_date,
  remarks text,
  rtv_purchase_return_id integer references purchase_returns(id) on delete set null,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (goods_receipt_id),
  check (qc_status in ('draft', 'closed', 'cancelled'))
);

create index if not exists idx_quality_controls_grn_id on quality_controls(goods_receipt_id);

create table if not exists quality_control_lines (
  id serial primary key,
  quality_control_id integer not null references quality_controls(id) on delete cascade,
  goods_receipt_line_id integer not null references goods_receipt_lines(id) on delete cascade,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty_received numeric(18, 4) not null default 0,
  qty_accepted numeric(18, 4) not null default 0,
  qty_on_hold numeric(18, 4) not null default 0,
  qty_rejected numeric(18, 4) not null default 0,
  qty_rtv_created numeric(18, 4) not null default 0,
  hold_reason text,
  rejection_reason text,
  unique (quality_control_id, line_no),
  unique (quality_control_id, goods_receipt_line_id),
  check (qty_received >= 0),
  check (qty_accepted >= 0),
  check (qty_on_hold >= 0),
  check (qty_rejected >= 0),
  check (qty_rtv_created >= 0)
);

create index if not exists idx_quality_control_lines_qc_id on quality_control_lines(quality_control_id);
