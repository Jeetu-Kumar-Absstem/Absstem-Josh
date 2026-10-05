-- 195: Frozen copy of every sent quote PDF, per-salesperson email signature,
-- and a record of what was attached to each quote mail.

alter table attachments
  drop constraint if exists attachments_owner_type_check;

alter table attachments
  add constraint attachments_owner_type_check
  check (owner_type = any (array[
    'legacy',
    'template',
    'quote_document',
    'dispatch_pod',
    'company_profile',
    'quote_mail_attachment',
    'expense_receipt',
    'pilot_screenshot',
    'service_signed_report',
    'quote_customer_datasheet',
    'quote_engineering_datasheet',
    'quote_sent_pdf'
  ]));

alter table erp_users
  add column if not exists email_signature text;

alter table quote_mail_logs
  add column if not exists attachments_json jsonb,
  add column if not exists attachments_total_bytes bigint;
