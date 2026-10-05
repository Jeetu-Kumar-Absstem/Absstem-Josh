alter table quality_control_lines
add column if not exists qty_replaced numeric(18, 4) not null default 0,
add column if not exists qty_reworked numeric(18, 4) not null default 0,
add column if not exists qty_accepted_after_hold numeric(18, 4) not null default 0;

alter table quality_control_lines
drop constraint if exists quality_control_lines_qty_replaced_check;

alter table quality_control_lines
add constraint quality_control_lines_qty_replaced_check check (qty_replaced >= 0);

alter table quality_control_lines
drop constraint if exists quality_control_lines_qty_reworked_check;

alter table quality_control_lines
add constraint quality_control_lines_qty_reworked_check check (qty_reworked >= 0);

alter table quality_control_lines
drop constraint if exists quality_control_lines_qty_accepted_after_hold_check;

alter table quality_control_lines
add constraint quality_control_lines_qty_accepted_after_hold_check check (qty_accepted_after_hold >= 0);

create table if not exists quality_hold_actions (
  id serial primary key,
  quality_control_id integer not null references quality_controls(id) on delete cascade,
  quality_control_line_id integer not null references quality_control_lines(id) on delete cascade,
  action_type text not null,
  action_date date not null default current_date,
  qty numeric(18, 4) not null default 0,
  reference_no text,
  expected_date date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action_type in ('supplier_replacement', 'rework', 'final_acceptance')),
  check (qty > 0)
);

create index if not exists idx_quality_hold_actions_qc_id on quality_hold_actions(quality_control_id);
create index if not exists idx_quality_hold_actions_line_id on quality_hold_actions(quality_control_line_id);
