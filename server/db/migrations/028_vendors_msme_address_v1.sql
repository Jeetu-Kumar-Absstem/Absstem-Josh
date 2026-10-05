alter table vendors
add column if not exists address_line1 text,
add column if not exists address_line2 text,
add column if not exists address_line3 text,
add column if not exists city text,
add column if not exists state text,
add column if not exists pincode text,
add column if not exists msme_registered boolean not null default false;

