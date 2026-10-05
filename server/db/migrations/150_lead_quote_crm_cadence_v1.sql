-- Lead/Quote CRM Waves A–C: quote cadence fields + lead assign SLA clocks.

alter table quote_headers
  add column if not exists quote_valid_till date;

alter table quote_headers
  add column if not exists next_follow_up_at timestamptz;

alter table quote_headers
  add column if not exists quote_kind text;

update quote_headers
set quote_kind = coalesce(nullif(trim(quote_kind), ''), 'firm')
where quote_kind is null or trim(quote_kind) = '';

alter table quote_headers
  alter column quote_kind set default 'firm';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quote_headers_quote_kind_check'
  ) then
    alter table quote_headers
      add constraint quote_headers_quote_kind_check
      check (quote_kind in ('budgetary', 'firm'));
  end if;
end $$;

comment on column quote_headers.quote_valid_till is
  'Commercial validity end date for issued quotes; drives expiring Sales Desk / My Day cues.';
comment on column quote_headers.next_follow_up_at is
  'Next chase date for sales follow-up on open quotes.';

alter table leads
  add column if not exists assigned_at timestamptz;

alter table leads
  add column if not exists assign_sla_hours integer;

alter table leads
  add column if not exists first_response_at timestamptz;

alter table leads
  add column if not exists competitor_name text;

comment on column leads.assigned_at is
  'When current assignee was set; used for handoff SLA.';
comment on column leads.assign_sla_hours is
  'Hours allowed before first response after assign (default 24 if null).';
comment on column leads.first_response_at is
  'First post-assign activity timestamp for SLA measurement.';
comment on column leads.competitor_name is
  'Optional lost-to / competitor name when closing as lost.';

create index if not exists idx_quote_headers_valid_till
  on quote_headers (quote_valid_till)
  where quote_valid_till is not null
    and quote_status in ('issued', 'sent', 'approved');

create index if not exists idx_quote_headers_next_follow_up
  on quote_headers (next_follow_up_at)
  where next_follow_up_at is not null
    and quote_status in ('issued', 'sent', 'approved');

create index if not exists idx_leads_assigned_at
  on leads (assigned_at)
  where assigned_at is not null
    and coalesce(status, '') not in ('order_won', 'lost', 'closed', 'cancelled');

create index if not exists idx_lead_activities_due_at
  on lead_activities (due_at)
  where due_at is not null;
