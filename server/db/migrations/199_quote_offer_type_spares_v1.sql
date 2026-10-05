-- 199: Completes (plants / capital equipment) vs Spares & Aftermarket (spares, consumables, AMC / CMC) quotes.
-- offer_type drives terms seeding and the PDF layout. offer_type_source = 'auto' lets the quote lines decide
-- (main equipment present => completes); 'manual' means a person picked it and it is never auto-changed.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'quote_headers' and column_name = 'offer_type'
  ) then
    alter table quote_headers add column offer_type text not null default 'completes';
    -- Quotes that exist before this migration keep today's layout and terms: lock them as manual.
    alter table quote_headers add column offer_type_source text not null default 'manual';
    alter table quote_headers alter column offer_type_source set default 'auto';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quote_headers_offer_type_chk') then
    alter table quote_headers
      add constraint quote_headers_offer_type_chk check (offer_type in ('completes', 'spares'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quote_headers_offer_type_source_chk') then
    alter table quote_headers
      add constraint quote_headers_offer_type_source_chk check (offer_type_source in ('auto', 'manual'));
  end if;
end $$;

-- Terms Library: which quote type a clause belongs to, and optional wording used on spares quotes.
alter table terms_master add column if not exists applies_to text not null default 'all';
alter table terms_master add column if not exists spares_description text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'terms_master_applies_to_chk') then
    alter table terms_master
      add constraint terms_master_applies_to_chk check (applies_to in ('all', 'completes', 'spares'));
  end if;
end $$;

-- Plant-only clauses (civil / cabling exclusions, erection & commissioning supervision).
update terms_master
set applies_to = 'completes', updated_at = now()
where applies_to = 'all'
  and spares_description is null
  and (upper(caption) like '%EXCLUSION%' or upper(caption) like '%ERECTION%' or upper(caption) like '%COMMISSIONING%');

update terms_master
set spares_description = '100% advance against Proforma Invoice.', updated_at = now()
where spares_description is null and upper(trim(caption)) in ('PAYMENT TERMS', 'PAYMENT TERM', 'PAYMENT');

update terms_master
set spares_description = 'Ex-works. Ready-stock items: 1-2 weeks from receipt of PO and payment. Non-stock items: lead time confirmed at order acceptance, subject to prior sale.',
    updated_at = now()
where spares_description is null and upper(trim(caption)) in ('DELIVERY', 'DELIVERY PERIOD', 'DELIVERY SCHEDULE');

update terms_master
set spares_description = 'Replacement parts are warranted against manufacturing defects for 6 months from the date of dispatch. Consumables and wear parts (filter elements, gaskets, O-rings, adsorbent media and similar) are not covered, nor is damage from improper installation, operation, or use alongside non-genuine parts.',
    updated_at = now()
where spares_description is null and upper(trim(caption)) in ('WARRANTY', 'WARRANTY PERIOD');

insert into terms_master (sort_order, caption, default_description, applies_to, is_active)
select v.sort_order, v.caption, v.description, 'spares', true
from (
  values
    (11, 'Price Basis', 'Prices are ex-works for supply of the listed parts only. Installation or replacement at site, if required, is charged separately at our service visit rates or covered under your AMC / CMC.'),
    (12, 'Part Compatibility', 'Parts are offered against the part numbers and equipment details shared by you. Please confirm the equipment model and serial number with your PO. Absstem is not responsible for incompatibility arising from incorrect or incomplete details.'),
    (13, 'Returns & Cancellation', 'Parts once supplied are not returnable or exchangeable, except for warranty replacement of defective parts. Orders for non-stock or specially procured items cannot be cancelled once confirmed.')
) as v(sort_order, caption, description)
where not exists (select 1 from terms_master t where upper(trim(t.caption)) = upper(v.caption));

-- The Payment Terms clause is rewritten from the quote's selected payment term, so spares need a matching master row.
insert into payment_terms (term_code, term_name, is_active)
select 'ADV100', '100% Advance against Proforma Invoice', true
where not exists (select 1 from payment_terms where upper(trim(term_code)) = 'ADV100');
