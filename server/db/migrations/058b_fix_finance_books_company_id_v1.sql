alter table finance_books add column if not exists company_id integer;

update finance_books
set company_id = company_id_by_code('AI')
where company_id is null;