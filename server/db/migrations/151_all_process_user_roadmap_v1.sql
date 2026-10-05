-- AR dunning ladder: scheduled chase dates on outstanding customer invoices.

alter table customer_invoices
  add column if not exists dunning_stage integer;

alter table customer_invoices
  add column if not exists next_dunning_at date;

alter table customer_invoices
  add column if not exists last_dunning_at date;

comment on column customer_invoices.dunning_stage is
  'Dunning ladder step (0=none, 1=friendly, 2=firm, 3=escalated).';
comment on column customer_invoices.next_dunning_at is
  'Next scheduled dunning / collection chase date.';
comment on column customer_invoices.last_dunning_at is
  'Date of last dunning action stamped on this invoice.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_invoices_dunning_stage_chk'
  ) then
    alter table customer_invoices
      add constraint customer_invoices_dunning_stage_chk
      check (dunning_stage is null or (dunning_stage >= 0 and dunning_stage <= 5));
  end if;
end $$;

create index if not exists idx_customer_invoices_next_dunning
  on customer_invoices (company_id, next_dunning_at)
  where next_dunning_at is not null
    and invoice_status in ('issued', 'paid');

alter table customer_collection_actions
  drop constraint if exists customer_collection_actions_action_type_chk;

alter table customer_collection_actions
  add constraint customer_collection_actions_action_type_chk
  check (action_type in (
    'follow_up',
    'promise_to_pay',
    'reminder_sent',
    'dispute',
    'escalated',
    'resolved',
    'dunning'
  ));

-- Reorder / min-max stock on company product policies (Wave 4 shared).
alter table company_product_policies
  add column if not exists min_stock numeric(18, 4);

alter table company_product_policies
  add column if not exists reorder_qty numeric(18, 4);

alter table company_product_policies
  add column if not exists safety_stock numeric(18, 4);

comment on column company_product_policies.min_stock is
  'Reorder alert when stock_qty falls at or below this level.';
comment on column company_product_policies.reorder_qty is
  'Suggested PR qty when min_stock is breached.';
comment on column company_product_policies.safety_stock is
  'Optional safety buffer used with min_stock alerts.';

-- Vendor promised delivery date on PO lines (Wave 4).
alter table purchase_order_lines
  add column if not exists promised_date date;

comment on column purchase_order_lines.promised_date is
  'Vendor promised delivery date; drives po_promise_overdue exceptions.';

create index if not exists idx_purchase_order_lines_promised_date
  on purchase_order_lines (promised_date)
  where promised_date is not null;

-- Service ticket SLA clocks (Wave 3 P1).
alter table service_tickets
  add column if not exists first_response_at timestamptz;

alter table service_tickets
  add column if not exists resolve_by_at timestamptz;

alter table service_tickets
  add column if not exists assign_sla_hours integer;

comment on column service_tickets.first_response_at is
  'First engineer touch after assignment.';
comment on column service_tickets.resolve_by_at is
  'Target resolution deadline for SLA.';
comment on column service_tickets.assign_sla_hours is
  'Hours allowed before first response after assign.';

-- Expense policy limits (Wave 5).
create table if not exists expense_policy_limits (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  category text not null,
  daily_cap numeric(18, 2),
  claim_cap numeric(18, 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, category)
);

comment on table expense_policy_limits is
  'Per-company expense category caps enforced on HR self-service claim submit.';

alter table approval_policies
  drop constraint if exists approval_policies_doc_type_check;

alter table approval_policies
  add constraint approval_policies_doc_type_check
  check (doc_type in (
    'purchase_requisition',
    'purchase_order',
    'goods_receipt',
    'purchase_invoice',
    'vendor_payment',
    'leave_request',
    'expense_claim'
  ));

alter table approval_action_history
  drop constraint if exists approval_action_history_doc_type_check;

alter table approval_action_history
  add constraint approval_action_history_doc_type_check
  check (doc_type in (
    'purchase_requisition',
    'purchase_order',
    'goods_receipt',
    'purchase_invoice',
    'vendor_payment',
    'leave_request',
    'expense_claim'
  ));
