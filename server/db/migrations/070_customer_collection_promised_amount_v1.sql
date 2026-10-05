alter table customer_collection_actions
add column if not exists promised_amount numeric(14, 2);

alter table customer_collection_actions
drop constraint if exists customer_collection_actions_promised_amount_chk;

alter table customer_collection_actions
add constraint customer_collection_actions_promised_amount_chk
check (promised_amount is null or promised_amount >= 0);

create index if not exists idx_customer_collection_actions_promised_amount
on customer_collection_actions(promised_amount);
