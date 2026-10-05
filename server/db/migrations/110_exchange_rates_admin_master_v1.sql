alter table if exists exchange_rates
add column if not exists is_active boolean not null default true;

create index if not exists idx_exchange_rates_pair_date
  on exchange_rates(from_currency_id, to_currency_id, rate_date desc);
