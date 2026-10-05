create table if not exists email_opt_outs (
  email citext primary key,
  opted_out_at timestamptz not null default now(),
  reason text,
  source text,
  created_by integer references erp_users(id) on delete set null
);

create table if not exists marketing_mailers (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  mailer_name text not null,
  mailer_type text not null default 'newsletter',
  subject text not null,
  body_text text not null,
  include_event_details boolean not null default false,
  campaign_id integer references marketing_campaigns(id) on delete set null,
  exhibition_id integer references marketing_exhibitions(id) on delete set null,
  mailer_status text not null default 'draft',
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mailer_type in ('newsletter', 'event_awareness')),
  check (mailer_status in ('draft', 'sent'))
);

create index if not exists idx_marketing_mailers_company_status
  on marketing_mailers(company_id, mailer_status, created_at desc);

create table if not exists marketing_mail_logs (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  mailer_id integer not null references marketing_mailers(id) on delete cascade,
  to_email citext not null,
  sender_source text,
  sender_email citext,
  provider text,
  message_id text,
  tracking_token text,
  unsubscribe_token text,
  sent_at timestamptz not null default now(),
  error_text text,
  opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0,
  clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0
);

create unique index if not exists ux_marketing_mail_logs_tracking_token
  on marketing_mail_logs(tracking_token)
  where tracking_token is not null;

create unique index if not exists ux_marketing_mail_logs_unsubscribe_token
  on marketing_mail_logs(unsubscribe_token)
  where unsubscribe_token is not null;

create index if not exists idx_marketing_mail_logs_company_mailer
  on marketing_mail_logs(company_id, mailer_id, sent_at desc);
