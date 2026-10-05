-- Phase 3: quote owner vs editor, team scope, send on behalf, leave cover, Chat readiness.

alter table quote_headers
  add column if not exists owner_user_id integer references erp_users(id);

update quote_headers set owner_user_id = created_by where owner_user_id is null;

create index if not exists idx_quote_headers_owner_user_id on quote_headers(owner_user_id);

create or replace function quote_headers_default_owner() returns trigger
language plpgsql as $$
begin
  if new.owner_user_id is null then
    new.owner_user_id := new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quote_headers_default_owner on quote_headers;
create trigger trg_quote_headers_default_owner
  before insert on quote_headers
  for each row execute function quote_headers_default_owner();

alter table quote_revisions
  add column if not exists edited_by integer references erp_users(id),
  add column if not exists edited_at timestamptz;

alter table quote_mail_logs
  add column if not exists on_behalf_of_user_id integer references erp_users(id);

create table if not exists quote_owner_changes (
  id bigserial primary key,
  quote_id integer not null references quote_headers(id) on delete cascade,
  from_user_id integer references erp_users(id),
  to_user_id integer not null references erp_users(id),
  changed_by integer references erp_users(id),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_quote_owner_changes_quote on quote_owner_changes(quote_id, created_at desc);

create table if not exists quote_cover_delegations (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  from_user_id integer not null references erp_users(id),
  to_user_id integer not null references erp_users(id),
  start_date date not null,
  end_date date not null,
  note text,
  hr_leave_request_id integer references hr_leave_requests(id) on delete set null,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by integer references erp_users(id),
  constraint quote_cover_dates_chk check (end_date >= start_date),
  constraint quote_cover_distinct_chk check (from_user_id <> to_user_id)
);

create index if not exists idx_quote_cover_to_active
  on quote_cover_delegations(to_user_id, start_date, end_date) where cancelled_at is null;
create index if not exists idx_quote_cover_from_active
  on quote_cover_delegations(from_user_id, start_date, end_date) where cancelled_at is null;

create table if not exists user_chat_delivery_status (
  user_id integer primary key references erp_users(id) on delete cascade,
  last_attempt_at timestamptz,
  last_ok_at timestamptz,
  last_reason text
);
