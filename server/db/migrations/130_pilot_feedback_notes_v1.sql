create table if not exists pilot_feedback_notes (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  created_by integer not null references erp_users(id) on delete cascade,
  note_type text not null check (note_type in ('blocked', 'confusing', 'suggestion')),
  desk_page text not null,
  desk_label text,
  company_code text,
  reference_no text,
  note_body text not null,
  status text not null default 'open' check (status in ('open', 'triaged', 'done', 'wont_fix')),
  triage_note text,
  triaged_by integer references erp_users(id) on delete set null,
  triaged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pilot_feedback_notes_created_idx
  on pilot_feedback_notes (created_at desc);

create index if not exists pilot_feedback_notes_status_idx
  on pilot_feedback_notes (status, created_at desc);

create index if not exists pilot_feedback_notes_type_idx
  on pilot_feedback_notes (note_type, created_at desc);

create index if not exists pilot_feedback_notes_desk_idx
  on pilot_feedback_notes (desk_page, created_at desc);

create index if not exists pilot_feedback_notes_company_idx
  on pilot_feedback_notes (company_id, created_at desc);
