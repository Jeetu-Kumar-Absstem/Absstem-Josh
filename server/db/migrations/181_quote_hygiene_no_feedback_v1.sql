-- Quotation report hygiene: Closed - No Feedback reason + optional ingest audit table

insert into quote_closure_reasons (reason_code, reason_name, sort_order, is_active)
values
  ('no_feedback', 'Closed - No Feedback', 60, true),
  ('project_shelved', 'Closed - Project Shelved', 35, true),
  ('another_quote', 'Another Quote', 55, true)
on conflict (reason_code) do update
set
  reason_name = excluded.reason_name,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  updated_at = now();

create table if not exists quotation_report_hygiene_runs (
  id serial primary key,
  batch_key text not null unique,
  source_file text not null,
  cutoff_date date not null,
  total_rows integer not null default 0,
  test_archived integer not null default 0,
  auto_closed integer not null default 0,
  db_matched integer not null default 0,
  db_updated integer not null default 0,
  db_test_cancelled integer not null default 0,
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
