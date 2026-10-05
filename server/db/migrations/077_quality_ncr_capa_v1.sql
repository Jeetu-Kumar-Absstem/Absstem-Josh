create table if not exists quality_ncr_cases (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  ncr_number text not null,
  quality_control_id integer not null references quality_controls(id) on delete cascade,
  quality_control_line_id integer references quality_control_lines(id) on delete set null,
  source_type text not null default 'quality_control',
  severity text not null default 'medium',
  category text not null default 'other',
  qty_affected numeric(18, 4) not null default 0,
  defect_summary text not null,
  containment_action text,
  containment_owner_id integer references erp_users(id) on delete set null,
  containment_due_date date,
  containment_completed_date date,
  root_cause text,
  corrective_plan text,
  preventive_plan text,
  verification_method text,
  verified_by integer references erp_users(id) on delete set null,
  verification_date date,
  status text not null default 'open',
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, ncr_number),
  check (source_type in ('quality_control')),
  check (severity in ('low', 'medium', 'high', 'critical')),
  check (category in ('incoming_defect', 'process_deviation', 'vendor_quality', 'documentation', 'packaging', 'other')),
  check (qty_affected >= 0),
  check (status in ('open', 'contained', 'root_cause_pending', 'action_in_progress', 'verification_pending', 'closed', 'cancelled'))
);

create index if not exists idx_quality_ncr_cases_qc_id on quality_ncr_cases(quality_control_id);
create index if not exists idx_quality_ncr_cases_line_id on quality_ncr_cases(quality_control_line_id);
create index if not exists idx_quality_ncr_cases_status on quality_ncr_cases(company_id, status);

create table if not exists quality_capa_actions (
  id serial primary key,
  ncr_case_id integer not null references quality_ncr_cases(id) on delete cascade,
  action_type text not null,
  action_title text not null,
  owner_user_id integer references erp_users(id) on delete set null,
  due_date date,
  completed_date date,
  action_status text not null default 'open',
  completion_note text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action_type in ('correction', 'corrective', 'preventive')),
  check (action_status in ('open', 'in_progress', 'done', 'cancelled'))
);

create index if not exists idx_quality_capa_actions_ncr_id on quality_capa_actions(ncr_case_id);
