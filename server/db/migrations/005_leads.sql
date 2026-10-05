create table if not exists lead_sources (
  id serial primary key,
  source_code text not null unique,
  source_name text not null,
  is_active boolean not null default true
);

create table if not exists leads (
  id serial primary key,
  lead_number text not null unique,
  company_name text not null,
  lead_source_id integer references lead_sources(id),
  distributor_id integer references distributors(id),
  customer_id integer references customers(id),
  status text not null default 'new',
  priority text not null default 'medium',
  assigned_to integer references erp_users(id),
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_leads_status on leads(status);
create index if not exists idx_leads_assigned_to on leads(assigned_to);
create index if not exists idx_leads_distributor_id on leads(distributor_id);

create table if not exists lead_contacts (
  id serial primary key,
  lead_id integer not null references leads(id) on delete cascade,
  full_name text not null,
  email citext,
  phone text,
  designation text,
  is_primary boolean not null default false
);

create index if not exists idx_lead_contacts_lead_id on lead_contacts(lead_id);

create table if not exists lead_assignments (
  id serial primary key,
  lead_id integer not null references leads(id) on delete cascade,
  assigned_to integer not null references erp_users(id),
  assigned_by integer not null references erp_users(id),
  assignment_reason text,
  assigned_at timestamptz not null default now()
);

create index if not exists idx_lead_assignments_lead_id on lead_assignments(lead_id);

create table if not exists lead_activities (
  id serial primary key,
  lead_id integer not null references leads(id) on delete cascade,
  activity_type text not null,
  subject text not null,
  notes text,
  due_at timestamptz,
  activity_at timestamptz not null default now(),
  created_by integer references erp_users(id)
);

create index if not exists idx_lead_activities_lead_id on lead_activities(lead_id);
