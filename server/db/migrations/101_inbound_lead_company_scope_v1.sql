alter table inbound_mailboxes
  add column if not exists company_id integer references companies(id) on delete restrict;

create index if not exists idx_inbound_mailboxes_company_id
  on inbound_mailboxes(company_id);

alter table inbound_lead_emails
  add column if not exists company_id integer references companies(id) on delete restrict;

create index if not exists idx_inbound_lead_emails_company_id
  on inbound_lead_emails(company_id);

create index if not exists idx_inbound_lead_emails_company_status
  on inbound_lead_emails(company_id, review_status, received_at desc);

update inbound_lead_emails e
set company_id = m.company_id
from inbound_mailboxes m
where e.company_id is null
  and e.mailbox_id = m.id
  and m.company_id is not null;
