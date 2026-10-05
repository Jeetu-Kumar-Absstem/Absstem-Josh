do $$
begin
  alter table dispatches
    add column if not exists intercompany_goods_receipt_id integer references goods_receipts(id) on delete set null;

  create index if not exists idx_dispatches_intercompany_goods_receipt_id on dispatches(intercompany_goods_receipt_id);

  alter table goods_receipts
    add column if not exists intercompany_dispatch_id integer references dispatches(id) on delete set null;

  create unique index if not exists idx_goods_receipts_company_intercompany_dispatch_unique
    on goods_receipts(company_id, intercompany_dispatch_id)
    where intercompany_dispatch_id is not null;
end $$;

