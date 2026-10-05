-- IMAP fallback mailbox for indsales@absstem.com (Phase 3 ingest)
-- Allows provider=imap and optional empty refresh_token for non-Google mailboxes.

alter table inbound_mailboxes
  drop constraint if exists inbound_mailboxes_provider_check;

alter table inbound_mailboxes
  add constraint inbound_mailboxes_provider_check
  check (provider in ('google', 'imap'));

alter table inbound_mailboxes
  alter column refresh_token drop not null;

alter table inbound_mailboxes
  alter column refresh_token set default '';

-- Ensure indsales IMAP fallback mailbox exists (do not clobber a live Google OAuth mailbox).
insert into inbound_mailboxes (
  mailbox_key,
  provider,
  mailbox_email,
  display_name,
  refresh_token,
  sync_interval_minutes,
  is_active,
  company_id
)
select
  'indsales',
  'imap',
  'indsales@absstem.com',
  'Indsales IMAP fallback',
  'imap-local',
  5,
  true,
  (select id from companies where upper(company_code) = 'AI' order by id asc limit 1)
where not exists (
  select 1 from inbound_mailboxes where mailbox_key = 'indsales'
);

update inbound_mailboxes
set
  provider = 'imap',
  mailbox_email = coalesce(nullif(mailbox_email, ''), 'indsales@absstem.com'),
  display_name = coalesce(nullif(display_name, ''), 'Indsales IMAP fallback'),
  refresh_token = coalesce(nullif(refresh_token, ''), 'imap-local'),
  sync_interval_minutes = least(greatest(coalesce(sync_interval_minutes, 5), 5), 60),
  is_active = true,
  updated_at = now()
where mailbox_key = 'indsales'
  and (
    provider = 'imap'
    or coalesce(refresh_token, '') in ('', 'imap-local')
  );
