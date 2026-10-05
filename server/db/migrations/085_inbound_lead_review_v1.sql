create table if not exists inbound_mailboxes (
  id serial primary key,
  mailbox_key text not null unique,
  provider text not null default 'google',
  mailbox_email citext not null,
  display_name text,
  refresh_token text not null,
  access_token text,
  scope_text text,
  sync_interval_minutes integer not null default 15,
  last_synced_at timestamptz,
  last_error text,
  connected_by integer references erp_users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mailbox_key in ('contact', 'indsales')),
  check (provider in ('google')),
  check (sync_interval_minutes between 5 and 1440)
);

create table if not exists inbound_lead_emails (
  id serial primary key,
  mailbox_id integer not null references inbound_mailboxes(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  internet_message_id text,
  received_at timestamptz,
  from_name text,
  from_email citext,
  subject text,
  body_text text,
  body_preview text,
  parse_contact_name text,
  parse_company_name text,
  parse_phone text,
  confidence_score integer not null default 0,
  review_status text not null default 'pending',
  converted_lead_id integer references leads(id) on delete set null,
  matched_lead_id integer references leads(id) on delete set null,
  reviewed_by integer references erp_users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_status in ('pending', 'converted', 'linked_existing', 'ignored'))
);

create unique index if not exists idx_inbound_lead_emails_mailbox_message
  on inbound_lead_emails(mailbox_id, gmail_message_id);

create index if not exists idx_inbound_lead_emails_status
  on inbound_lead_emails(review_status, received_at desc);

create index if not exists idx_inbound_lead_emails_from_email
  on inbound_lead_emails(from_email);

insert into lead_sources (source_code, source_name, is_active)
values ('EMAIL_INBOUND', 'Inbound Email Review', true)
on conflict (source_code) do update set
  source_name = excluded.source_name,
  is_active = true;
