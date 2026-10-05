-- P1c: Tally export foundation (accounting vouchers only).

create table if not exists tally_ledger_maps (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  map_scope text not null
    check (map_scope in (
      'party', 'sales', 'output_cgst', 'output_sgst', 'output_igst',
      'round_off', 'bank', 'cash', 'freight', 'packing_forwarding'
    )),
  match_key text,
  tally_ledger_name text not null,
  tally_parent_group text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_tally_ledger_maps_unique
  on tally_ledger_maps (company_id, map_scope, coalesce(match_key, ''));

create index if not exists idx_tally_ledger_maps_company
  on tally_ledger_maps (company_id) where is_active = true;

create table if not exists tally_export_runs (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  export_type text not null check (export_type in ('sales', 'receipts')),
  date_from date,
  date_to date,
  voucher_count integer not null default 0,
  filters jsonb,
  generated_by integer references erp_users(id),
  generated_at timestamptz not null default now()
);

create index if not exists idx_tally_export_runs_company
  on tally_export_runs (company_id, generated_at desc);

insert into tally_ledger_maps (company_id, map_scope, match_key, tally_ledger_name, tally_parent_group)
select c.id, v.map_scope, null, v.tally_ledger_name, v.tally_parent_group
from companies c
cross join (
  values
    ('sales', 'Sales Account', 'Sales Accounts'),
    ('output_cgst', 'Output CGST', 'Duties & Taxes'),
    ('output_sgst', 'Output SGST', 'Duties & Taxes'),
    ('output_igst', 'Output IGST', 'Duties & Taxes'),
    ('round_off', 'Round Off', 'Indirect Expenses'),
    ('bank', 'Bank Account', 'Bank Accounts'),
    ('cash', 'Cash', 'Cash-in-Hand'),
    ('freight', 'Freight Outward', 'Sales Accounts'),
    ('packing_forwarding', 'Packing & Forwarding', 'Sales Accounts')
) as v(map_scope, tally_ledger_name, tally_parent_group)
where not exists (
  select 1
  from tally_ledger_maps m
  where m.company_id = c.id
    and m.map_scope = v.map_scope
    and coalesce(m.match_key, '') = ''
);

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
  'tally_export',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'gl_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
