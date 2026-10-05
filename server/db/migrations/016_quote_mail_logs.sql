create table if not exists quote_mail_logs (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  attachment_id integer references attachments(id),
  mail_mode text not null default 'standard',
  recipient_to text not null,
  recipient_cc text,
  recipient_bcc text,
  subject text not null,
  body_text text,
  smtp_message_id text,
  send_status text not null default 'sent',
  error_text text,
  sent_by integer references erp_users(id),
  sent_at timestamptz not null default now(),
  check (mail_mode in ('standard', 'clubbed')),
  check (send_status in ('queued', 'sent', 'failed'))
);

create index if not exists idx_quote_mail_logs_quote_revision_id
  on quote_mail_logs(quote_revision_id, sent_at desc);
