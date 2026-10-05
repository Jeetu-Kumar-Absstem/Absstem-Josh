-- Optional intake description / initial lead context on New Lead
alter table leads
  add column if not exists description text;
