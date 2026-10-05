-- Pilot note optional screenshot

alter table pilot_feedback_notes
  add column if not exists screenshot_attachment_id integer references attachments(id) on delete set null;

create index if not exists pilot_feedback_notes_screenshot_idx
  on pilot_feedback_notes (screenshot_attachment_id)
  where screenshot_attachment_id is not null;

alter table attachments
  drop constraint if exists attachments_owner_type_check;

alter table attachments
  add constraint attachments_owner_type_check
  check (
    owner_type in (
      'legacy',
      'template',
      'quote_document',
      'dispatch_pod',
      'company_profile',
      'quote_mail_attachment',
      'expense_receipt',
      'pilot_screenshot'
    )
  );
