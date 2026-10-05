drop index if exists idx_dispatches_sales_order_id_unique;
create index if not exists idx_dispatches_sales_order_id on dispatches(sales_order_id);

drop index if exists idx_customer_invoices_sales_order_id_unique;
create index if not exists idx_customer_invoices_sales_order_id on customer_invoices(sales_order_id);
