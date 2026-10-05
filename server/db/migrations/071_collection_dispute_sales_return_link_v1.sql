alter table customer_collection_disputes
add column if not exists sales_return_id integer references sales_returns(id) on delete set null;

create unique index if not exists idx_customer_collection_disputes_sales_return_id
on customer_collection_disputes(sales_return_id)
where sales_return_id is not null;
