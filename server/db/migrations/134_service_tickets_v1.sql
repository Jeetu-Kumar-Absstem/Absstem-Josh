-- Service Tickets Phase 1 (AT pilot): complaints, assignment, visits, signed reports

create table if not exists service_tickets (
  id bigserial primary key,
  company_id integer not null references companies(id),
  ticket_number text not null,
  ticket_status text not null default 'open'
    check (ticket_status in ('open', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed', 'cancelled')),
  ticket_priority text not null default 'normal'
    check (ticket_priority in ('critical', 'high', 'normal', 'low')),
  complaint_type text not null default 'complaint'
    check (complaint_type in ('complaint', 'breakdown', 'installation', 'commissioning', 'preventive', 'other')),
  customer_id integer not null references customers(id),
  job_asset_id integer null references job_assets(id) on delete set null,
  assigned_to_user_id integer null references erp_users(id) on delete set null,
  site_name text null,
  site_address text null,
  reported_by text null,
  symptom_summary text not null,
  remarks text null,
  reported_at timestamptz not null default now(),
  due_date date null,
  resolved_at timestamptz null,
  created_by integer null references erp_users(id) on delete set null,
  updated_by integer null references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, ticket_number)
);

create index if not exists service_tickets_company_status_idx
  on service_tickets (company_id, ticket_status, created_at desc);

create index if not exists service_tickets_assignee_idx
  on service_tickets (assigned_to_user_id)
  where assigned_to_user_id is not null;

create index if not exists service_tickets_customer_idx
  on service_tickets (customer_id);

create index if not exists service_tickets_job_asset_idx
  on service_tickets (job_asset_id)
  where job_asset_id is not null;

create table if not exists service_ticket_assignments (
  id bigserial primary key,
  ticket_id bigint not null references service_tickets(id) on delete cascade,
  assigned_to integer not null references erp_users(id),
  assigned_by integer null references erp_users(id) on delete set null,
  assignment_reason text null,
  assigned_at timestamptz not null default now()
);

create index if not exists service_ticket_assignments_ticket_idx
  on service_ticket_assignments (ticket_id, assigned_at desc);

create table if not exists service_ticket_visits (
  id bigserial primary key,
  ticket_id bigint not null references service_tickets(id) on delete cascade,
  visit_no integer not null,
  scheduled_date date null,
  visit_status text not null default 'scheduled'
    check (visit_status in ('scheduled', 'checked_in', 'completed', 'missed', 'cancelled')),
  engineer_user_id integer null references erp_users(id) on delete set null,
  -- Field markers only — HR/Field My Day remains attendance source of truth
  checked_in_at timestamptz null,
  checked_out_at timestamptz null,
  visit_notes text null,
  customer_signatory_name text null,
  signed_at timestamptz null,
  signed_report_attachment_id integer null references attachments(id) on delete set null,
  created_by integer null references erp_users(id) on delete set null,
  updated_by integer null references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ticket_id, visit_no)
);

create index if not exists service_ticket_visits_ticket_idx
  on service_ticket_visits (ticket_id, visit_no);

create index if not exists service_ticket_visits_engineer_idx
  on service_ticket_visits (engineer_user_id)
  where engineer_user_id is not null;

alter table attachments
  drop constraint if exists attachments_owner_type_check;

alter table attachments
  add constraint attachments_owner_type_check
  check (
    owner_type in (
      'legacy',
      'template',
      'quote_document',
      'dispatch_pod',
      'company_profile',
      'quote_mail_attachment',
      'expense_receipt',
      'pilot_screenshot',
      'service_signed_report'
    )
  );

-- Grant service_tickets to roles that already have service_warranty
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
  'service_tickets',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'service_warranty'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
