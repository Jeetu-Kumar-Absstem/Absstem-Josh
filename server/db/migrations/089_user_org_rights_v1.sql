create table if not exists departments (
  department_key text primary key,
  department_name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into departments (department_key, department_name, sort_order)
values
  ('sales', 'Sales', 10),
  ('marketing', 'Marketing', 20),
  ('service', 'Service', 30),
  ('engineering', 'Engineering', 40),
  ('projects', 'Projects', 50),
  ('accounts', 'Accounts', 60),
  ('production', 'Production', 70),
  ('dispatch', 'Dispatch', 80),
  ('packing', 'Packing', 90),
  ('office_admin', 'Admin (Office Admin)', 95),
  ('hr', 'HR', 100)
on conflict (department_key) do update
set
  department_name = excluded.department_name,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table erp_users
  add column if not exists department_key text references departments(department_key) on delete set null;

alter table erp_users
  add column if not exists employment_company_id integer references companies(id) on delete set null;

create index if not exists idx_erp_users_department_key on erp_users(department_key);
create index if not exists idx_erp_users_employment_company_id on erp_users(employment_company_id);

