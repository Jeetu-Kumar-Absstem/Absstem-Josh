-- MRN MVP: link job cards (material requests) to service tickets / visits

alter table job_cards
  add column if not exists service_ticket_id bigint null references service_tickets(id) on delete set null;

alter table job_cards
  add column if not exists service_ticket_visit_id bigint null references service_ticket_visits(id) on delete set null;

create index if not exists job_cards_service_ticket_idx
  on job_cards (service_ticket_id)
  where service_ticket_id is not null;

create index if not exists job_cards_service_ticket_visit_idx
  on job_cards (service_ticket_visit_id)
  where service_ticket_visit_id is not null;
