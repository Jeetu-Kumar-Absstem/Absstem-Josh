create sequence if not exists erp_user_code_seq start with 1001 increment by 1;

alter table erp_users
add column if not exists user_code text;

alter table erp_users
alter column user_code set default ('U' || lpad(nextval('erp_user_code_seq')::text, 5, '0'));

update erp_users
set user_code = 'U' || lpad(nextval('erp_user_code_seq')::text, 5, '0')
where user_code is null;

create unique index if not exists idx_erp_users_user_code on erp_users(user_code);

alter table erp_users
add column if not exists company_name text;

alter table erp_users
add column if not exists employee_code text;

alter table erp_users
add column if not exists primary_manager_user_id integer references erp_users(id);

alter table erp_users
add column if not exists secondary_manager_user_id integer references erp_users(id);

alter table erp_users
add column if not exists date_of_joining date;

alter table erp_users
add column if not exists local_address text;

alter table erp_users
add column if not exists permanent_address text;

alter table erp_users
add column if not exists discount_threshold_pct numeric(5, 2);

create index if not exists idx_erp_users_primary_manager_user_id on erp_users(primary_manager_user_id);
create index if not exists idx_erp_users_secondary_manager_user_id on erp_users(secondary_manager_user_id);
