create table if not exists mail_accounts (
  id serial primary key,
  owner_type text not null,
  user_id integer references erp_users(id) on delete cascade,
  distributor_id integer references distributors(id) on delete cascade,
  provider text not null,
  mailbox_email citext not null,
  display_name text,
  refresh_token text not null,
  access_token text,
  token_expiry_at timestamptz,
  scope_text text,
  connected_by integer references erp_users(id),
  last_used_at timestamptz,
  last_verified_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_type in ('user', 'distributor')),
  check (provider in ('google')),
  check (
    (owner_type = 'user' and user_id is not null and distributor_id is null) or
    (owner_type = 'distributor' and distributor_id is not null and user_id is null)
  ),
  unique (user_id, provider),
  unique (distributor_id, provider)
);

create index if not exists idx_mail_accounts_user_id
  on mail_accounts(user_id);

create index if not exists idx_mail_accounts_distributor_id
  on mail_accounts(distributor_id);

alter table quote_mail_logs
  add column if not exists sender_source text;

alter table quote_mail_logs
  add column if not exists sender_email citext;
