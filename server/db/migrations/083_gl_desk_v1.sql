do $$
begin
  create table if not exists gl_accounts (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    account_code text not null,
    account_name text not null,
    account_type text not null,
    normal_balance text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create unique index if not exists idx_gl_accounts_company_code_unique
    on gl_accounts(company_id, account_code);
  create index if not exists idx_gl_accounts_company_active
    on gl_accounts(company_id, is_active);

  alter table gl_accounts
    drop constraint if exists gl_accounts_account_type_chk;
  alter table gl_accounts
    add constraint gl_accounts_account_type_chk
    check (account_type in ('asset', 'liability', 'equity', 'income', 'expense'));

  alter table gl_accounts
    drop constraint if exists gl_accounts_normal_balance_chk;
  alter table gl_accounts
    add constraint gl_accounts_normal_balance_chk
    check (normal_balance in ('debit', 'credit'));

  create table if not exists gl_journals (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    journal_no text not null,
    journal_date date not null default current_date,
    journal_status text not null default 'draft',
    narration text,
    created_by integer references erp_users(id) on delete set null,
    posted_by integer references erp_users(id) on delete set null,
    posted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create unique index if not exists idx_gl_journals_company_no_unique
    on gl_journals(company_id, journal_no);
  create index if not exists idx_gl_journals_company_status
    on gl_journals(company_id, journal_status);
  create index if not exists idx_gl_journals_company_date
    on gl_journals(company_id, journal_date);

  alter table gl_journals
    drop constraint if exists gl_journals_status_chk;
  alter table gl_journals
    add constraint gl_journals_status_chk
    check (journal_status in ('draft', 'posted', 'cancelled'));

  create table if not exists gl_journal_lines (
    id serial primary key,
    journal_id integer not null references gl_journals(id) on delete cascade,
    line_no integer not null,
    account_id integer not null references gl_accounts(id) on delete restrict,
    line_remarks text,
    debit numeric(18, 2) not null default 0,
    credit numeric(18, 2) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (journal_id, line_no)
  );

  create index if not exists idx_gl_journal_lines_journal_id
    on gl_journal_lines(journal_id);
  create index if not exists idx_gl_journal_lines_account_id
    on gl_journal_lines(account_id);

  alter table gl_journal_lines
    drop constraint if exists gl_journal_lines_amount_chk;
  alter table gl_journal_lines
    add constraint gl_journal_lines_amount_chk
    check (
      debit >= 0
      and credit >= 0
      and not (debit > 0 and credit > 0)
      and (debit > 0 or credit > 0)
    );
end $$;

