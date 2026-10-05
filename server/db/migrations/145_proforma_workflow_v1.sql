-- P1a: Proforma workflow extensions + screen rights.
-- Tables already created in 142; this adds operational columns and permissions.

alter table proforma_invoice_lines
  add column if not exists charge_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'proforma_invoice_lines_charge_kind_check'
  ) then
    alter table proforma_invoice_lines
      add constraint proforma_invoice_lines_charge_kind_check
      check (charge_kind is null or charge_kind in ('packing_forwarding', 'freight'));
  end if;
end $$;

create index if not exists idx_proforma_lines_charge_kind
  on proforma_invoice_lines (proforma_invoice_id, charge_kind)
  where charge_kind is not null;

alter table proforma_invoices
  add column if not exists issued_at timestamptz,
  add column if not exists issued_by integer references erp_users(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by integer references erp_users(id),
  add column if not exists cancel_reason text;

create unique index if not exists idx_proforma_one_live_per_milestone
  on proforma_invoices (payment_milestone_id)
  where payment_milestone_id is not null
    and proforma_status not in ('cancelled', 'expired');

create index if not exists idx_proforma_converted_invoice_id
  on proforma_invoices (converted_invoice_id)
  where converted_invoice_id is not null;

create index if not exists idx_proforma_company_status
  on proforma_invoices (company_id, proforma_status);

alter table payment_milestones
  add column if not exists sort_order integer,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by integer references erp_users(id);

update payment_milestones
set sort_order = id
where sort_order is null;

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
  'proforma_invoices',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'invoices'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
