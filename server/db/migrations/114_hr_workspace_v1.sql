insert into erp_modules (module_key, module_name)
values ('hr', 'HR')
on conflict (module_key) do update
set module_name = excluded.module_name;

create table if not exists hr_attendance_records (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  employee_user_id integer references erp_users(id) on delete set null,
  employee_name text not null,
  department_name text,
  shift_name text,
  attendance_status text not null default 'present',
  attendance_date date not null default current_date,
  in_time time,
  out_time time,
  note text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_attendance_records_company_date
  on hr_attendance_records(company_id, attendance_date desc);

create index if not exists idx_hr_attendance_records_company_status
  on hr_attendance_records(company_id, attendance_status);

create table if not exists hr_expense_claims (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  employee_user_id integer references erp_users(id) on delete set null,
  employee_name text not null,
  purpose text not null,
  category text not null,
  amount numeric(12,2) not null default 0,
  claim_status text not null default 'manager_pending',
  bill_status text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_expense_claims_company_status
  on hr_expense_claims(company_id, claim_status);

create index if not exists idx_hr_expense_claims_company_created
  on hr_expense_claims(company_id, created_at desc);

create table if not exists hr_planner_activities (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  owner_user_id integer references erp_users(id) on delete set null,
  owner_name text not null,
  title text not null,
  department_name text,
  due_date date not null,
  activity_stage text not null default 'planned',
  priority text not null default 'medium',
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_planner_activities_company_stage
  on hr_planner_activities(company_id, activity_stage);

create index if not exists idx_hr_planner_activities_company_due
  on hr_planner_activities(company_id, due_date asc);

create table if not exists hr_events (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  title text not null,
  event_type text not null,
  event_date date not null,
  venue text not null,
  event_status text not null default 'registration_open',
  participants_count integer not null default 0,
  note text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_events_company_status
  on hr_events(company_id, event_status);

create index if not exists idx_hr_events_company_date
  on hr_events(company_id, event_date asc);
