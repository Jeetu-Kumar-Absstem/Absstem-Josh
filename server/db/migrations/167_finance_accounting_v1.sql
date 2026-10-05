-- 167: Finance & Accounting Engine (Phase 7: General Ledger, Automated Invoicing, 3-Way Match & GST Reconciliation)

-- 1. Chart of Accounts Table (Hierarchical Master GL Accounts)
create table if not exists chart_of_accounts (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  account_code text not null,
  account_name text not null,
  account_type text not null, -- 'asset', 'liability', 'equity', 'revenue', 'expense'
  parent_id bigint references chart_of_accounts(id) on delete set null,
  normal_balance text not null default 'debit', -- 'debit', 'credit'
  description text,
  is_reconciliation boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chart_of_accounts_type_check check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  constraint chart_of_accounts_balance_check check (normal_balance in ('debit', 'credit')),
  constraint chart_of_accounts_code_unique unique (company_id, account_code)
);

create index if not exists idx_chart_of_accounts_company_type
  on chart_of_accounts(company_id, account_type, is_active);

-- Seed standard system chart of accounts if missing
insert into chart_of_accounts (company_id, account_code, account_name, account_type, normal_balance, description)
select c.id, code, name, acct_type, balance, descr
from companies c
cross join (
  values
    ('1100', 'Accounts Receivable (Trade Debtors)', 'asset', 'debit', 'Receivables from customers against tax invoices'),
    ('1200', 'Inventory Finished Goods', 'asset', 'debit', 'Valuation of finished stock on hand'),
    ('1300', 'GST Input Tax Credit (ITC Receivable)', 'asset', 'debit', 'Input GST paid to vendors eligible for setoff'),
    ('1400', 'Bank & Cash Accounts', 'asset', 'debit', 'Liquid operational bank accounts'),
    ('2100', 'Accounts Payable (Trade Creditors)', 'liability', 'credit', 'Payables to approved suppliers and vendors'),
    ('2200', 'GST Output Tax Liability', 'liability', 'credit', 'Output GST collected from customers on sales'),
    ('3100', 'Retained Earnings', 'equity', 'credit', 'Cumulative company earnings'),
    ('4100', 'Sales Revenue', 'revenue', 'credit', 'Gross revenue from customer sales orders'),
    ('5100', 'Cost of Goods Sold (COGS)', 'expense', 'debit', 'Landed material & direct manufacturing cost'),
    ('5200', 'Shop Floor Scrap & Variance Expense', 'expense', 'debit', 'Financial variance cost from scrapped materials')
) as t(code, name, acct_type, balance, descr)
on conflict (company_id, account_code) do nothing;

-- 2. General Ledger Double-Entry Audit Trail
create table if not exists general_ledger_entries (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  entry_number text not null,
  account_id bigint not null references chart_of_accounts(id) on delete restrict,
  entry_date date not null default current_date,
  source_event text not null, -- 'SALES_INVOICE', 'DISPATCH', 'VENDOR_BILL', 'SCRAP_VARIANCE', 'PAYMENT'
  ref_type text,
  ref_id bigint,
  debit numeric(18, 2) not null default 0,
  credit numeric(18, 2) not null default 0,
  narration text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint gl_entries_debit_credit_positive check (debit >= 0 and credit >= 0),
  constraint gl_entries_non_zero check (debit > 0 or credit > 0)
);

create index if not exists idx_gl_entries_company_date
  on general_ledger_entries(company_id, entry_date);

create index if not exists idx_gl_entries_account
  on general_ledger_entries(account_id, entry_date);

create index if not exists idx_gl_entries_source_ref
  on general_ledger_entries(ref_type, ref_id);

-- 3. Enhance Customer Invoices (AR, GST & Dispatch Linkage)
alter table customer_invoices
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists dispatch_id bigint references dispatches(id) on delete set null,
  add column if not exists due_date date,
  add column if not exists paid_amount numeric(18, 2) not null default 0,
  add column if not exists balance_due numeric(18, 2) not null default 0,
  add column if not exists cgst_amount numeric(18, 2) not null default 0,
  add column if not exists sgst_amount numeric(18, 2) not null default 0,
  add column if not exists igst_amount numeric(18, 2) not null default 0,
  add column if not exists is_interstate boolean not null default false,
  add column if not exists customer_gstin text,
  add column if not exists ar_gl_entry_id bigint references general_ledger_entries(id) on delete set null;

create index if not exists idx_customer_invoices_company_status
  on customer_invoices(company_id, invoice_status, invoice_date);

-- 4. Vendor Bills & 3-Way Match AP Table
create table if not exists vendor_bills (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  bill_number text not null,
  vendor_id integer not null references vendors(id) on delete restrict,
  purchase_order_id integer references purchase_orders(id) on delete set null,
  goods_receipt_id bigint references goods_receipts(id) on delete set null,
  vendor_invoice_ref text not null,
  bill_date date not null default current_date,
  due_date date,
  subtotal numeric(18, 2) not null default 0,
  tax_total numeric(18, 2) not null default 0,
  grand_total numeric(18, 2) not null default 0,
  paid_amount numeric(18, 2) not null default 0,
  match_status text not null default 'pending', -- 'pending', 'matched_ok', 'qty_mismatch', 'price_mismatch', 'locked_unverified'
  payment_status text not null default 'unpaid', -- 'unpaid', 'partially_paid', 'paid', 'on_hold'
  statutory_verified boolean not null default false,
  match_notes text,
  ap_gl_entry_id bigint references general_ledger_entries(id) on delete set null,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_bills_match_check check (match_status in ('pending', 'matched_ok', 'qty_mismatch', 'price_mismatch', 'locked_unverified')),
  constraint vendor_bills_payment_check check (payment_status in ('unpaid', 'partially_paid', 'paid', 'on_hold')),
  constraint vendor_bills_unique_ref unique (company_id, vendor_id, vendor_invoice_ref)
);

create index if not exists idx_vendor_bills_company_match
  on vendor_bills(company_id, match_status, payment_status);

create table if not exists vendor_bill_lines (
  id bigserial primary key,
  vendor_bill_id bigint not null references vendor_bills(id) on delete cascade,
  line_no integer not null,
  item_code text not null,
  item_name text not null,
  hsn_no text,
  qty_billed numeric(14, 4) not null default 1,
  unit_price_billed numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total numeric(18, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint vendor_bill_lines_qty_positive check (qty_billed > 0)
);

-- Screen permissions for finance_desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'finance_desk', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'finance_manager', 'finance_executive', 'cfo', 'accounts_head', 'commercial_head')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
