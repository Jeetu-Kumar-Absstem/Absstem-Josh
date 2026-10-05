update purchase_returns pr
set company_id = gr.company_id
from goods_receipts gr
where pr.company_id is null
  and pr.goods_receipt_id is not null
  and gr.id = pr.goods_receipt_id;

update purchase_returns pr
set company_id = pi.company_id
from purchase_invoices pi
where pr.company_id is null
  and pr.purchase_invoice_id is not null
  and pi.id = pr.purchase_invoice_id;

update purchase_returns
set company_id = company_id_by_code('AI')
where company_id is null;