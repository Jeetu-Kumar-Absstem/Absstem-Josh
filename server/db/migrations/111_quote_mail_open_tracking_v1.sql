alter table quote_mail_logs
  add column if not exists tracking_token text;

alter table quote_mail_logs
  add column if not exists opened_at timestamptz;

alter table quote_mail_logs
  add column if not exists last_opened_at timestamptz;

alter table quote_mail_logs
  add column if not exists open_count integer not null default 0;

create unique index if not exists idx_quote_mail_logs_tracking_token
  on quote_mail_logs(tracking_token)
  where tracking_token is not null;
