-- P0a: customer product maps + customer item code snapshots on commercial lines
-- Also adds customer PO header fields on SO / tax invoices (backfill from buyer_po where present).

create table if not exists customer_product_maps (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  customer_id integer not null references customers(id) on delete cascade,
  product_id integer not null references products(id) on delete cascade,
  customer_item_code text not null,
  customer_item_description text,
  customer_uom text,
  is_active boolean not null default true,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(customer_item_code)) > 0)
);

create unique index if not exists idx_cpm_company_customer_product_active
  on customer_product_maps (company_id, customer_id, product_id)
  where is_active = true;

create index if not exists idx_cpm_customer_lookup
  on customer_product_maps (company_id, customer_id, customer_item_code);

create index if not exists idx_cpm_product_id on customer_product_maps (product_id);

alter table quote_lines
  add column if not exists customer_item_code text,
  add column if not exists customer_item_description text;

alter table sales_order_lines
  add column if not exists customer_item_code text,
  add column if not exists customer_item_description text;

alter table invoice_lines
  add column if not exists customer_item_code text,
  add column if not exists customer_item_description text;

do $$
begin
  if to_regclass('public.dispatch_lines') is not null then
    alter table dispatch_lines
      add column if not exists customer_item_code text,
      add column if not exists customer_item_description text;
  end if;
end $$;

alter table sales_orders
  add column if not exists customer_po_number text,
  add column if not exists customer_po_date date;

alter table customer_invoices
  add column if not exists customer_po_number text,
  add column if not exists customer_po_date date,
  add column if not exists irn text,
  add column if not exists irn_ack_no text,
  add column if not exists irn_ack_date timestamptz,
  add column if not exists signed_qr_code text;

update sales_orders
set
  customer_po_number = coalesce(nullif(trim(customer_po_number), ''), nullif(trim(buyer_po_number), ''), customer_po_number),
  customer_po_date = coalesce(customer_po_date, buyer_po_date)
where customer_po_number is null or customer_po_date is null;

create index if not exists idx_customer_invoices_customer_po_number
  on customer_invoices (customer_po_number)
  where customer_po_number is not null;

create unique index if not exists idx_customer_invoices_company_irn_unique
  on customer_invoices (company_id, irn)
  where irn is not null and length(trim(irn)) > 0;

-- Separate Proforma shell (P1 will wire full billing workflow). Kept out of customer_invoices / AR.
create table if not exists proforma_invoices (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  proforma_number text not null,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  payment_milestone_id integer references payment_milestones(id) on delete set null,
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  proforma_status text not null default 'draft'
    check (proforma_status in ('draft', 'issued', 'converted', 'adjusted', 'cancelled', 'expired')),
  billing_basis text not null default 'milestone'
    check (billing_basis in ('milestone', 'qty', 'adhoc')),
  billed_percent numeric(7, 4),
  proforma_date date not null default current_date,
  valid_till date,
  customer_po_number text,
  customer_po_date date,
  base_currency_id integer not null references currencies(id),
  proforma_currency_id integer not null references currencies(id),
  subtotal_base numeric(14, 2) not null default 0,
  subtotal_proforma numeric(14, 2) not null default 0,
  tax_total_base numeric(14, 2) not null default 0,
  tax_total_proforma numeric(14, 2) not null default 0,
  grand_total_base numeric(14, 2) not null default 0,
  grand_total_proforma numeric(14, 2) not null default 0,
  attention_to text,
  remarks text,
  converted_invoice_id integer references customer_invoices(id) on delete set null,
  converted_at timestamptz,
  converted_by integer references erp_users(id),
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_proforma_company_number_unique
  on proforma_invoices (company_id, proforma_number);

create index if not exists idx_proforma_sales_order_id on proforma_invoices (sales_order_id);
create index if not exists idx_proforma_customer_id on proforma_invoices (customer_id);
create index if not exists idx_proforma_customer_po_number
  on proforma_invoices (customer_po_number)
  where customer_po_number is not null;

create table if not exists proforma_invoice_lines (
  id serial primary key,
  proforma_invoice_id integer not null references proforma_invoices(id) on delete cascade,
  sales_order_line_id integer references sales_order_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  customer_item_code text,
  customer_item_description text,
  hsn_no text,
  qty numeric(14, 3) not null default 1,
  unit_price_base numeric(14, 2) not null default 0,
  unit_price_proforma numeric(14, 2) not null default 0,
  gst_pct numeric(7, 4) not null default 0,
  billed_percent numeric(7, 4),
  line_total_base numeric(14, 2) not null default 0,
  line_total_proforma numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proforma_invoice_id, line_no)
);

create index if not exists idx_proforma_invoice_lines_header on proforma_invoice_lines (proforma_invoice_id);
