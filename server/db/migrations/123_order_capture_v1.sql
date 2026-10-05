alter table quote_headers
  add column if not exists order_flow text not null default 'direct',
  add column if not exists fulfillment_mode text not null default 'direct_customer',
  add column if not exists buyer_po_number text,
  add column if not exists buyer_po_date date,
  add column if not exists po_exception_reason text,
  add column if not exists end_customer_name text,
  add column if not exists end_customer_po_number text,
  add column if not exists end_customer_po_date date;

alter table sales_orders
  add column if not exists order_flow text not null default 'direct',
  add column if not exists fulfillment_mode text not null default 'direct_customer',
  add column if not exists buyer_po_number text,
  add column if not exists buyer_po_date date,
  add column if not exists po_exception_reason text,
  add column if not exists end_customer_name text,
  add column if not exists end_customer_po_number text,
  add column if not exists end_customer_po_date date;
