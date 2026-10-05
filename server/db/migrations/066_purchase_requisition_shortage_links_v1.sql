alter table purchase_requisition_lines
add column if not exists source_job_card_id integer references job_cards(id) on delete set null;

alter table purchase_requisition_lines
add column if not exists source_job_card_line_id integer references job_card_lines(id) on delete set null;

alter table purchase_requisition_lines
add column if not exists source_shortage_action_id integer references job_card_line_shortage_actions(id) on delete set null;

create index if not exists idx_purchase_requisition_lines_source_job_card_id
  on purchase_requisition_lines(source_job_card_id);

create index if not exists idx_purchase_requisition_lines_source_job_card_line_id
  on purchase_requisition_lines(source_job_card_line_id);

create unique index if not exists ux_purchase_requisition_lines_source_shortage_action_id
  on purchase_requisition_lines(source_shortage_action_id)
  where source_shortage_action_id is not null;
