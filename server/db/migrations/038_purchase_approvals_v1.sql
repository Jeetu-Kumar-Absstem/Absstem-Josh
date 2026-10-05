alter table purchase_orders
add column if not exists submitted_by integer references erp_users(id),
add column if not exists submitted_at timestamptz,
add column if not exists approved_by integer references erp_users(id),
add column if not exists approved_at timestamptz;

update purchase_orders
set po_status = 'approved'
where po_status = 'confirmed';

alter table purchase_orders
drop constraint if exists purchase_orders_po_status_check;

alter table purchase_orders
add constraint purchase_orders_po_status_check
check (po_status in ('draft', 'submitted', 'approved', 'closed', 'cancelled'));

alter table goods_receipts
add column if not exists submitted_by integer references erp_users(id),
add column if not exists submitted_at timestamptz,
add column if not exists approved_by integer references erp_users(id),
add column if not exists approved_at timestamptz;

alter table goods_receipts
drop constraint if exists goods_receipts_receipt_status_check;

alter table goods_receipts
add constraint goods_receipts_receipt_status_check
check (receipt_status in ('draft', 'submitted', 'approved', 'posted', 'cancelled'));

alter table purchase_invoices
add column if not exists submitted_by integer references erp_users(id),
add column if not exists submitted_at timestamptz,
add column if not exists approved_by integer references erp_users(id),
add column if not exists approved_at timestamptz;

alter table purchase_invoices
drop constraint if exists purchase_invoices_invoice_status_check;

alter table purchase_invoices
add constraint purchase_invoices_invoice_status_check
check (invoice_status in ('draft', 'submitted', 'approved', 'posted', 'cancelled'));

alter table vendor_payments
add column if not exists submitted_by integer references erp_users(id),
add column if not exists submitted_at timestamptz,
add column if not exists approved_by integer references erp_users(id),
add column if not exists approved_at timestamptz;

alter table vendor_payments
drop constraint if exists vendor_payments_payment_status_check;

alter table vendor_payments
add constraint vendor_payments_payment_status_check
check (payment_status in ('draft', 'submitted', 'approved', 'posted', 'cancelled'));
