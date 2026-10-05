-- Job numbers from commercial SO reports (e.g. SalesOrderReport export) for invoice/SO chain linking.

alter table sales_orders
  add column if not exists job_no text;

alter table customer_invoices
  add column if not exists job_no text;

create index if not exists idx_sales_orders_job_no
  on sales_orders (company_id, job_no)
  where job_no is not null and length(trim(job_no)) > 0;

create index if not exists idx_customer_invoices_job_no
  on customer_invoices (company_id, job_no)
  where job_no is not null and length(trim(job_no)) > 0;

comment on column sales_orders.job_no is 'Commercial job reference from SO report (e.g. N047); may be comma-separated for multi-job SOs';
comment on column customer_invoices.job_no is 'Job reference enriched from linked SO or Tally chain import';
