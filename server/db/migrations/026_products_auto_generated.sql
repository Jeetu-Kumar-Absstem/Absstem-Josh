alter table products
add column if not exists is_auto_generated boolean not null default false;

