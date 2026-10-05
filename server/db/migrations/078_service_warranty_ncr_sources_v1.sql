alter table quality_ncr_cases
add column if not exists service_warranty_case_id integer references service_warranty_cases(id) on delete cascade,
add column if not exists service_warranty_case_line_id integer references service_warranty_case_lines(id) on delete set null,
add column if not exists service_warranty_movement_id integer references service_warranty_movements(id) on delete set null;

alter table quality_ncr_cases
drop constraint if exists quality_ncr_cases_source_type_check;

alter table quality_ncr_cases
add constraint quality_ncr_cases_source_type_check
check (source_type in ('quality_control', 'service_warranty'));

create index if not exists idx_quality_ncr_cases_service_case_id on quality_ncr_cases(service_warranty_case_id);
create index if not exists idx_quality_ncr_cases_service_case_line_id on quality_ncr_cases(service_warranty_case_line_id);
create index if not exists idx_quality_ncr_cases_service_movement_id on quality_ncr_cases(service_warranty_movement_id);
