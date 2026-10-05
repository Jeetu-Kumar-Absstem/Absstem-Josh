alter table erp_users
add column if not exists designation text;

alter table erp_users
add column if not exists phone text;
