alter table quote_approvals
add column if not exists requested_by integer references erp_users(id);

alter table quote_approvals
add column if not exists acted_by_user_id integer references erp_users(id);

alter table quote_approvals
add column if not exists approval_cycle_no integer not null default 1;

alter table quote_approvals
add column if not exists created_at timestamptz not null default now();

alter table quote_approvals
add column if not exists updated_at timestamptz not null default now();

update quote_approvals
set approval_cycle_no = 1
where approval_cycle_no is null;

create index if not exists idx_quote_approvals_revision_cycle
on quote_approvals(quote_revision_id, approval_cycle_no, sequence_no);

create index if not exists idx_quote_approvals_approver_user_id
on quote_approvals(approver_user_id);
