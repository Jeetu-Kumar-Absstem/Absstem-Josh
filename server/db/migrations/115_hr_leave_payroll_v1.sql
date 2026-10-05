create table if not exists hr_leave_requests (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  employee_user_id integer references erp_users(id) on delete set null,
  employee_name text not null,
  leave_type text not null,
  start_date date not null,
  end_date date not null,
  total_days numeric(8,2) not null default 1,
  leave_status text not null default 'pending',
  reason text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_leave_requests_company_status
  on hr_leave_requests(company_id, leave_status);

create index if not exists idx_hr_leave_requests_company_dates
  on hr_leave_requests(company_id, start_date desc, end_date desc);

create table if not exists hr_holidays (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  holiday_name text not null,
  holiday_date date not null,
  holiday_type text not null default 'Company holiday',
  note text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, holiday_date, holiday_name)
);

create index if not exists idx_hr_holidays_company_date
  on hr_holidays(company_id, holiday_date asc);

create table if not exists hr_salary_profiles (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  employee_user_id integer references erp_users(id) on delete set null,
  employee_name text not null,
  department_name text,
  monthly_ctc numeric(12,2) not null default 0,
  basic_amount numeric(12,2) not null default 0,
  hra_amount numeric(12,2) not null default 0,
  special_allowance numeric(12,2) not null default 0,
  deductions_amount numeric(12,2) not null default 0,
  net_salary numeric(12,2) not null default 0,
  is_active boolean not null default true,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_salary_profiles_company_active
  on hr_salary_profiles(company_id, is_active);

create table if not exists hr_salary_slips (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  salary_profile_id integer references hr_salary_profiles(id) on delete set null,
  employee_user_id integer references erp_users(id) on delete set null,
  employee_name text not null,
  payroll_month date not null,
  basic_amount numeric(12,2) not null default 0,
  hra_amount numeric(12,2) not null default 0,
  special_allowance numeric(12,2) not null default 0,
  deductions_amount numeric(12,2) not null default 0,
  net_salary numeric(12,2) not null default 0,
  slip_status text not null default 'generated',
  paid_on date,
  generated_at timestamptz not null default now(),
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, salary_profile_id, payroll_month)
);

create index if not exists idx_hr_salary_slips_company_month
  on hr_salary_slips(company_id, payroll_month desc);

create index if not exists idx_hr_salary_slips_company_status
  on hr_salary_slips(company_id, slip_status);
