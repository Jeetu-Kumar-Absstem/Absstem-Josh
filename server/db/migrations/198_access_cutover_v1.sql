-- Access redesign Phases 3-4: person-level overrides UI and deny-by-default cutover checks.

alter table access_verification_runs drop constraint if exists access_verification_runs_run_kind_check;
alter table access_verification_runs
  add constraint access_verification_runs_run_kind_check
  check (run_kind in ('backfill', 'verify', 'cutover_check'));

alter table access_verification_runs add column if not exists deny_default boolean not null default false;
alter table access_verification_runs add column if not exists bypass_users integer not null default 0;
alter table access_verification_runs add column if not exists blockers jsonb not null default '[]'::jsonb;

create index if not exists idx_user_access_overrides_expiry
  on user_access_overrides (expires_at)
  where revoked_at is null and expires_at is not null;
