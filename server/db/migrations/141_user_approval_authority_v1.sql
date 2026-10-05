-- Phase P0: per-user approval authority on approval_policies
-- User-owned rows (user_id set, role/group null) define identity-centric ceilings.
-- Matching engine prefers user_id, then vendor, then group, then role.

alter table approval_policies
  add column if not exists user_id integer references erp_users(id) on delete cascade;

-- Drop legacy check that required role_id or group_id so user_id can be sole scope.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.approval_policies'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role_id%'
      and pg_get_constraintdef(c.oid) ilike '%group_id%'
      and pg_get_constraintdef(c.oid) not ilike '%user_id%'
  loop
    execute format('alter table approval_policies drop constraint %I', r.conname);
  end loop;
end $$;

alter table approval_policies
  drop constraint if exists approval_policies_scope_check;

alter table approval_policies
  add constraint approval_policies_scope_check
  check (
    user_id is not null
    or role_id is not null
    or group_id is not null
  );

create index if not exists idx_approval_policies_user_id
  on approval_policies (user_id, doc_type, company_id)
  where user_id is not null and is_active = true;

-- One active identity band per company + user + doc_type + level (no vendor edge cases).
create unique index if not exists idx_approval_policies_user_doc_level_uq
  on approval_policies (company_id, user_id, doc_type, level_no)
  where user_id is not null
    and is_active = true
    and vendor_id is null;
