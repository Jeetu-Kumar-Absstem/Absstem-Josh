alter table quality_ncr_cases
add column if not exists customer_collection_dispute_id integer references customer_collection_disputes(id) on delete cascade,
add column if not exists sales_return_id integer references sales_returns(id) on delete set null;

alter table quality_ncr_cases
drop constraint if exists quality_ncr_cases_source_type_check;

alter table quality_ncr_cases
add constraint quality_ncr_cases_source_type_check
check (source_type in ('quality_control', 'service_warranty', 'collection_dispute'));

create index if not exists idx_quality_ncr_cases_collection_dispute_id on quality_ncr_cases(customer_collection_dispute_id);
create index if not exists idx_quality_ncr_cases_sales_return_id on quality_ncr_cases(sales_return_id);
