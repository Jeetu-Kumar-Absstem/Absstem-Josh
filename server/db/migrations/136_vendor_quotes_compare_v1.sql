-- Thin PR-linked RFQ → vendor quotes → compare → PO (not an Excel rate-matrix clone).

-- RFQ header (one open RFQ per PR is typical; multiples allowed if prior closed/cancelled)
create table if not exists purchase_rfqs (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  rfq_number text not null,
  purchase_requisition_id integer not null references purchase_requisitions(id) on delete restrict,
  rfq_status text not null default 'draft',
  due_date date,
  remarks text,
  sent_at timestamptz,
  sent_by integer references erp_users(id) on delete set null,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (rfq_status in ('draft', 'sent', 'closed', 'cancelled'))
);

create unique index if not exists idx_purchase_rfqs_company_rfq_number_unique
  on purchase_rfqs(company_id, rfq_number);

create index if not exists idx_purchase_rfqs_company_id on purchase_rfqs(company_id);
create index if not exists idx_purchase_rfqs_requisition_id on purchase_rfqs(purchase_requisition_id);
create index if not exists idx_purchase_rfqs_status on purchase_rfqs(rfq_status);

-- Vendors invited on an RFQ
create table if not exists purchase_rfq_vendors (
  id serial primary key,
  purchase_rfq_id integer not null references purchase_rfqs(id) on delete cascade,
  vendor_id integer not null references vendors(id) on delete restrict,
  invite_status text not null default 'invited',
  invited_at timestamptz not null default now(),
  invited_by integer references erp_users(id) on delete set null,
  email_to text,
  email_sent_at timestamptz,
  email_error text,
  responded_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_rfq_id, vendor_id),
  check (invite_status in ('invited', 'responded', 'declined', 'cancelled'))
);

create index if not exists idx_purchase_rfq_vendors_rfq_id on purchase_rfq_vendors(purchase_rfq_id);
create index if not exists idx_purchase_rfq_vendors_vendor_id on purchase_rfq_vendors(vendor_id);
create index if not exists idx_purchase_rfq_vendors_status on purchase_rfq_vendors(invite_status);

-- Captured vendor quotes (manual receive MVP; optional RFQ link)
create table if not exists vendor_quotes (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  quote_number text not null,
  purchase_requisition_id integer not null references purchase_requisitions(id) on delete restrict,
  purchase_rfq_id integer references purchase_rfqs(id) on delete set null,
  purchase_rfq_vendor_id integer references purchase_rfq_vendors(id) on delete set null,
  vendor_id integer not null references vendors(id) on delete restrict,
  quote_status text not null default 'draft',
  quote_date date not null default current_date,
  payment_terms text,
  credit_days integer,
  delivery_days integer,
  compliance_ok boolean not null default true,
  compliance_notes text,
  remarks text,
  received_via text not null default 'manual',
  is_winner boolean not null default false,
  purchase_order_id integer references purchase_orders(id) on delete set null,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quote_status in ('draft', 'received', 'selected', 'cancelled')),
  check (received_via in ('manual', 'rfq', 'email')),
  check (credit_days is null or credit_days >= 0),
  check (delivery_days is null or delivery_days >= 0)
);

create unique index if not exists idx_vendor_quotes_company_quote_number_unique
  on vendor_quotes(company_id, quote_number);

create unique index if not exists idx_vendor_quotes_pr_vendor_active_unique
  on vendor_quotes(purchase_requisition_id, vendor_id)
  where quote_status <> 'cancelled';

create unique index if not exists idx_vendor_quotes_rfq_vendor_active_unique
  on vendor_quotes(purchase_rfq_vendor_id)
  where purchase_rfq_vendor_id is not null and quote_status <> 'cancelled';

create index if not exists idx_vendor_quotes_company_id on vendor_quotes(company_id);
create index if not exists idx_vendor_quotes_requisition_id on vendor_quotes(purchase_requisition_id);
create index if not exists idx_vendor_quotes_rfq_id on vendor_quotes(purchase_rfq_id);
create index if not exists idx_vendor_quotes_vendor_id on vendor_quotes(vendor_id);
create index if not exists idx_vendor_quotes_status on vendor_quotes(quote_status);
create index if not exists idx_vendor_quotes_winner
  on vendor_quotes(purchase_requisition_id)
  where is_winner = true;

create table if not exists vendor_quote_lines (
  id serial primary key,
  vendor_quote_id integer not null references vendor_quotes(id) on delete cascade,
  purchase_requisition_line_id integer not null references purchase_requisition_lines(id) on delete restrict,
  line_no integer not null,
  product_id integer references products(id) on delete set null,
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty numeric(18, 4) not null default 1,
  unit_price numeric(18, 4) not null default 0,
  freight_per_unit numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_quote_id, line_no),
  unique (vendor_quote_id, purchase_requisition_line_id),
  check (qty > 0),
  check (unit_price >= 0),
  check (freight_per_unit >= 0)
);

create index if not exists idx_vendor_quote_lines_quote_id on vendor_quote_lines(vendor_quote_id);
create index if not exists idx_vendor_quote_lines_pr_line_id on vendor_quote_lines(purchase_requisition_line_id);

-- Grant vendor_quotes to roles that already have purchase_orders
insert into screen_permissions (
  role_id,
  screen_key,
  can_view,
  can_create,
  can_edit,
  can_approve,
  own_records_only,
  financial_masking
)
select
  sp.role_id,
  'vendor_quotes',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'purchase_orders'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
