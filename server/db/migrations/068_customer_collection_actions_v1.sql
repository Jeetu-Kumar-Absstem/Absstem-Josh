create table if not exists customer_collection_actions (
  id serial primary key,
  company_id integer references companies(id) on delete cascade,
  distributor_id integer references distributors(id) on delete cascade,
  customer_id integer not null references customers(id) on delete cascade,
  customer_invoice_id integer references customer_invoices(id) on delete cascade,
  action_type text not null,
  action_date date not null default current_date,
  expected_date date,
  remarks text,
  created_by integer references erp_users(id) on delete restrict,
  created_at timestamptz not null default now()
);

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
    'resolved'
  ));

create index if not exists idx_customer_collection_actions_company_id on customer_collection_actions(company_id);
create index if not exists idx_customer_collection_actions_distributor_id on customer_collection_actions(distributor_id);
create index if not exists idx_customer_collection_actions_customer_id on customer_collection_actions(customer_id);
create index if not exists idx_customer_collection_actions_expected_date on customer_collection_actions(expected_date);
create index if not exists idx_customer_collection_actions_created_at on customer_collection_actions(created_at);

