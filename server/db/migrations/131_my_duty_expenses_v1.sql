-- My Duty & Expenses self-service: receipt on claim, duty uniqueness, attachment owner type

alter table hr_expense_claims
  add column if not exists receipt_attachment_id integer references attachments(id) on delete set null;

alter table hr_expense_claims
  add column if not exists job_card_id integer;

alter table hr_expense_claims
  add column if not exists service_case_id integer;

alter table hr_expense_claims
  add column if not exists reference_no text;

alter table hr_expense_claims
  add column if not exists source_channel text not null default 'hr_desk';

alter table hr_attendance_records
  add column if not exists source_channel text not null default 'hr_desk';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hr_expense_claims_source_channel_check'
  ) then
    alter table hr_expense_claims
      add constraint hr_expense_claims_source_channel_check
      check (source_channel in ('hr_desk', 'self_service'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hr_attendance_records_source_channel_check'
  ) then
    alter table hr_attendance_records
      add constraint hr_attendance_records_source_channel_check
      check (source_channel in ('hr_desk', 'self_service'));
  end if;
end $$;

create unique index if not exists hr_attendance_records_user_day_uidx
  on hr_attendance_records (company_id, employee_user_id, attendance_date)
  where employee_user_id is not null;

create index if not exists hr_expense_claims_receipt_idx
  on hr_expense_claims (receipt_attachment_id)
  where receipt_attachment_id is not null;

create index if not exists hr_expense_claims_employee_created_idx
  on hr_expense_claims (company_id, employee_user_id, created_at desc);

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
      'expense_receipt'
    )
  );
