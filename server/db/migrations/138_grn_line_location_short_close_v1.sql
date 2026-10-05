-- Thin GRN desk: optional line location/remarks + PO receipt short-close

alter table goods_receipt_lines
  add column if not exists location_id integer references stock_locations(id) on delete set null;

alter table goods_receipt_lines
  add column if not exists line_remarks text;

create index if not exists idx_goods_receipt_lines_location_id
  on goods_receipt_lines(location_id);

alter table purchase_orders
  add column if not exists receipt_short_closed_at timestamptz;

alter table purchase_orders
  add column if not exists receipt_short_closed_by integer references erp_users(id) on delete set null;

alter table purchase_orders
  add column if not exists receipt_short_close_remarks text;

create index if not exists idx_purchase_orders_receipt_short_closed
  on purchase_orders(company_id)
  where receipt_short_closed_at is not null;
