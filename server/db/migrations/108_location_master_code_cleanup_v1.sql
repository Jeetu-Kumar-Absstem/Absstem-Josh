update countries
set
  iso_code = upper(trim(iso_code))
where iso_code <> upper(trim(iso_code));

update states
set
  state_code = upper(trim(state_code)),
  updated_at = now()
where state_code <> upper(trim(state_code));

update cities
set
  city_code = upper(trim(city_code)),
  updated_at = now()
where city_code <> upper(trim(city_code));

update cities
set
  city_code = concat('CITY-', id::text),
  updated_at = now()
where nullif(trim(city_code), '') is null;

with manual_fix as (
  select
    c.id,
    fixes.new_code
  from cities c
  join states s on s.id = c.state_id
  join countries co on co.id = c.country_id
  join (
    values
      ('IN', 'GUJARAT', 'ANAND', 'ANND'),
      ('IN', 'MAHARASHTRA', 'ANANDNAGAR', 'ANNG'),
      ('IN', 'WEST BENGAL', 'BERHAMPORE', 'BRHP'),
      ('IN', 'ODISHA', 'BERHAMPUR', 'BRHU'),
      ('IN', 'MAHARASHTRA', 'BHIWANDI', 'BHWD'),
      ('IN', 'HARYANA', 'BHIWANI', 'BHWI'),
      ('IN', 'CHANDIGARH', 'CHANDIGARH', 'CHDG'),
      ('IN', 'MAHARASHTRA', 'CHANDRAPUR', 'CHDR'),
      ('IN', 'GUJARAT', 'GANDHIDHAM', 'GNDM'),
      ('IN', 'GUJARAT', 'GANDHINAGAR', 'GNNG'),
      ('IN', 'HARYANA', 'KARNAL', 'KRNL'),
      ('IN', 'ANDHRA PRADESH', 'KURNOOL', 'KRNO'),
      ('IN', 'UTTAR PRADESH', 'MUZAFFARNAGAR', 'MZFN'),
      ('IN', 'BIHAR', 'MUZAFFARPUR', 'MZFP')
  ) as fixes(country_code, state_name, city_name, new_code)
    on upper(trim(co.iso_code)) = fixes.country_code
   and upper(trim(s.state_name)) = fixes.state_name
   and upper(trim(c.city_name)) = fixes.city_name
)
update cities c
set
  city_code = manual_fix.new_code,
  updated_at = now()
from manual_fix
where c.id = manual_fix.id
  and c.city_code <> manual_fix.new_code;

with ranked_duplicates as (
  select
    id,
    upper(trim(city_code)) as normalized_code,
    row_number() over (
      partition by upper(trim(city_code))
      order by country_id asc, state_id asc, city_name asc, id asc
    ) as row_num,
    count(*) over (partition by upper(trim(city_code))) as code_count
  from cities
)
update cities c
set
  city_code = concat(ranked_duplicates.normalized_code, '-', ranked_duplicates.row_num::text),
  updated_at = now()
from ranked_duplicates
where c.id = ranked_duplicates.id
  and ranked_duplicates.code_count > 1
  and ranked_duplicates.row_num > 1;

create unique index if not exists uq_cities_city_code_normalized
  on cities ((upper(trim(city_code))));
