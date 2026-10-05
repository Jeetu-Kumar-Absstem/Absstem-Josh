create table if not exists job_card_line_shortage_actions (
  id serial primary key,
  job_card_id integer not null references job_cards(id) on delete cascade,
  job_card_line_id integer not null references job_card_lines(id) on delete cascade,
  action_type text not null,
  action_date date not null default current_date,
  shortage_qty numeric(18, 4),
  reference_no text,
  expected_date date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action_type in ('shortage_reported', 'blocked', 'follow_up', 'resolved')),
  check (shortage_qty is null or shortage_qty >= 0)
);

create index if not exists idx_job_card_shortage_actions_job_card_id
  on job_card_line_shortage_actions(job_card_id);

create index if not exists idx_job_card_shortage_actions_line_id
  on job_card_line_shortage_actions(job_card_line_id);
