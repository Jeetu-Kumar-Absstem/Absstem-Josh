alter table sales_orders
add column if not exists attention_to text;

alter table sales_orders
add column if not exists incoterm_id integer references incoterms(id);

alter table sales_orders
add column if not exists payment_term_id integer references payment_terms(id);

alter table sales_orders
add column if not exists freight_term_id integer references freight_terms(id);

alter table sales_orders
add column if not exists terms_snapshot text;

alter table sales_orders
add column if not exists remarks text;

create unique index if not exists idx_sales_orders_quote_revision_id_unique
on sales_orders(quote_revision_id)
where quote_revision_id is not null;
