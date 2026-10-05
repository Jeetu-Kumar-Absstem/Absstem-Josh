alter table company_profiles
  add column if not exists website text,
  add column if not exists logo_attachment_id integer references attachments(id),
  add column if not exists signature_attachment_id integer references attachments(id);
