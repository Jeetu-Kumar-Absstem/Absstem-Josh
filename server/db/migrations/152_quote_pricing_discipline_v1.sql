-- Wave 2: quote pricing discipline, send/lapse/acceptance, typed lead time, guardrails, price audit.

alter table quote_lines
  add column if not exists discount_pct numeric(5, 2) not null default 0,
  add column if not exists discount_amt numeric(18, 4) not null default 0,
  add column if not exists gross_unit_price_quote numeric(18, 4) not null default 0,
  add column if not exists list_price_snapshot numeric(18, 4) not null default 0;

alter table quote_lines
  drop constraint if exists quote_lines_discount_pct_chk;
alter table quote_lines
  add constraint quote_lines_discount_pct_chk check (discount_pct >= 0 and discount_pct <= 100);

alter table quote_headers
  add column if not exists first_sent_at timestamptz,
  add column if not exists last_sent_at timestamptz,
  add column if not exists lapsed_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists customer_po_ref text;

alter table quote_revisions
  add column if not exists delivery_lead_time_days integer,
  add column if not exists warranty_months integer;

alter table quote_closure_reasons
  add column if not exists outcome_kind text;

update quote_closure_reasons
set outcome_kind = case
  when reason_code = 'won_customer_po' then 'won'
  else 'lost'
end
where outcome_kind is null or btrim(outcome_kind) = '';

alter table quote_closure_reasons
  alter column outcome_kind set default 'lost';

alter table quote_closure_reasons
  drop constraint if exists quote_closure_reasons_outcome_kind_chk;
alter table quote_closure_reasons
  add constraint quote_closure_reasons_outcome_kind_chk check (outcome_kind in ('won', 'lost'));

insert into quote_closure_reasons (reason_code, reason_name, sort_order, is_active, outcome_kind)
values ('won_customer_po', 'Won — customer PO received', 5, true, 'won')
on conflict (reason_code) do update
set
  reason_name = excluded.reason_name,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  outcome_kind = excluded.outcome_kind,
  updated_at = now();

update quote_closure_reasons
set outcome_kind = 'won'
where reason_code = 'won_customer_po';

create table if not exists quote_pricing_guardrails (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  product_group_id integer references product_groups(id) on delete cascade,
  min_net_pct_of_list numeric(5, 2) not null default 0,
  requires_approval_below_pct numeric(5, 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_net_pct_of_list >= 0 and min_net_pct_of_list <= 100),
  check (requires_approval_below_pct is null or (requires_approval_below_pct >= 0 and requires_approval_below_pct <= 100))
);

create unique index if not exists idx_quote_pricing_guardrails_company_default
  on quote_pricing_guardrails (company_id)
  where product_group_id is null and is_active = true;

create unique index if not exists idx_quote_pricing_guardrails_company_group
  on quote_pricing_guardrails (company_id, product_group_id)
  where product_group_id is not null and is_active = true;

create table if not exists quote_line_price_audit (
  id serial primary key,
  quote_line_id integer not null references quote_lines(id) on delete cascade,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  old_unit_price_quote numeric(18, 4),
  new_unit_price_quote numeric(18, 4),
  old_discount_pct numeric(5, 2),
  new_discount_pct numeric(5, 2),
  changed_by integer references erp_users(id),
  changed_at timestamptz not null default now()
);

create index if not exists idx_quote_line_price_audit_line
  on quote_line_price_audit (quote_line_id, changed_at desc);

create index if not exists idx_quote_line_price_audit_revision
  on quote_line_price_audit (quote_revision_id, changed_at desc);

create index if not exists idx_quote_headers_first_sent_at on quote_headers (first_sent_at);
create index if not exists idx_quote_headers_lapsed_at on quote_headers (lapsed_at);
create index if not exists idx_quote_headers_quote_valid_till on quote_headers (quote_valid_till);

-- Backfill discount / gross / list snapshot from line_description JSON when present.
update quote_lines
set
  gross_unit_price_quote = coalesce(
    nullif((line_description::jsonb ->> 'gross_unit_price_quote')::numeric, 0),
    nullif(unit_price_quote, 0),
    0
  ),
  discount_pct = least(
    100,
    greatest(
      0,
      coalesce(
        nullif((line_description::jsonb ->> 'discount_pct')::numeric, 0),
        case
          when coalesce(nullif((line_description::jsonb ->> 'gross_unit_price_quote')::numeric, 0), 0) > 0
            and unit_price_quote is not null
          then round(
            (
              (
                (line_description::jsonb ->> 'gross_unit_price_quote')::numeric - unit_price_quote
              )
              / (line_description::jsonb ->> 'gross_unit_price_quote')::numeric
            ) * 100,
            2
          )
          else 0
        end,
        0
      )
    )
  ),
  discount_amt = coalesce(nullif((line_description::jsonb ->> 'discount_amt')::numeric, 0), 0),
  list_price_snapshot = coalesce(
    nullif((line_description::jsonb ->> 'source_list_price')::numeric, 0),
    nullif((line_description::jsonb ->> 'gross_unit_price_quote')::numeric, 0),
    nullif(unit_price_quote, 0),
    0
  )
where line_description is not null
  and left(btrim(line_description), 1) = '{';

update quote_lines
set gross_unit_price_quote = unit_price_quote
where coalesce(gross_unit_price_quote, 0) = 0
  and coalesce(unit_price_quote, 0) <> 0;

update quote_lines
set list_price_snapshot = gross_unit_price_quote
where coalesce(list_price_snapshot, 0) = 0
  and coalesce(gross_unit_price_quote, 0) <> 0;

-- Backfill send timestamps from successful mail logs.
update quote_headers q
set
  first_sent_at = coalesce(q.first_sent_at, s.first_sent),
  last_sent_at = coalesce(s.last_sent, q.last_sent_at),
  quote_status = case
    when q.quote_status = 'issued' then 'sent'
    else q.quote_status
  end
from (
  select
    qr.quote_id,
    min(qml.sent_at) as first_sent,
    max(qml.sent_at) as last_sent
  from quote_mail_logs qml
  join quote_revisions qr on qr.id = qml.quote_revision_id
  where qml.send_status = 'sent'
  group by qr.quote_id
) s
where s.quote_id = q.id;

-- Stamp currently expired live quotes as lapsed.
update quote_headers q
set
  lapsed_at = coalesce(q.lapsed_at, now()),
  quote_status = 'lapsed',
  updated_at = now()
where q.quote_status in ('issued', 'sent', 'approved')
  and q.quote_valid_till is not null
  and q.quote_valid_till < current_date
  and not exists (
    select 1
    from quote_revisions qr
    join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
    where qr.quote_id = q.id
  );
