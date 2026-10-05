create table if not exists inbound_lead_ignore_rules (
  id serial primary key,
  mailbox_key text,
  rule_type text not null,
  match_value text not null,
  reason text,
  created_by integer references erp_users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mailbox_key is null or mailbox_key in ('contact', 'indsales')),
  check (rule_type in ('sender_email', 'sender_domain', 'subject_contains'))
);

create unique index if not exists idx_inbound_lead_ignore_rules_unique
  on inbound_lead_ignore_rules (
    coalesce(mailbox_key, ''),
    rule_type,
    lower(match_value)
  );

create index if not exists idx_inbound_lead_ignore_rules_active
  on inbound_lead_ignore_rules (is_active, mailbox_key, rule_type);

alter table inbound_lead_emails
  add column if not exists duplicate_of_email_id integer references inbound_lead_emails(id) on delete set null;

alter table inbound_lead_emails
  add column if not exists content_signature text;

create index if not exists idx_inbound_lead_emails_signature
  on inbound_lead_emails (mailbox_id, from_email, content_signature);
