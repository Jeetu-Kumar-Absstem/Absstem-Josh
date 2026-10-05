alter table marketing_exhibitions
  add column if not exists distributor_id integer references distributors(id) on delete set null,
  add column if not exists collaboration_mode text not null default 'company',
  add column if not exists cost_split_mode text not null default 'shared',
  add column if not exists distributor_spend numeric(14, 2) not null default 0;

alter table marketing_exhibitions
  add constraint marketing_exhibitions_collaboration_mode_chk
  check (collaboration_mode in ('company', 'joint')) not valid;

alter table marketing_exhibitions
  add constraint marketing_exhibitions_cost_split_mode_chk
  check (cost_split_mode in ('company', 'distributor', 'shared')) not valid;

alter table marketing_exhibitions
  validate constraint marketing_exhibitions_collaboration_mode_chk;

alter table marketing_exhibitions
  validate constraint marketing_exhibitions_cost_split_mode_chk;

create index if not exists idx_marketing_exhibitions_distributor_id
  on marketing_exhibitions(distributor_id);
