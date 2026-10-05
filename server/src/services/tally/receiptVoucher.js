const { ledgerEntry, voucherBlock, voucherBalance } = require("./tallyXml");
const { money2: money } = require("./money");

function buildReceiptVoucherXml(receipt, allocations, ledgers) {
  const partyLedger = ledgers.getParty(receipt.customer_id, receipt.customer_name);
  const paymentLedger = ledgers.getPaymentLedger(receipt.payment_mode, receipt.bank_name);
  const amount = money(receipt.receipt_amount_invoice);

  const billAllocations = [];
  let allocatedTotal = 0;
  for (const row of allocations) {
    const allocAmount = money(row.allocated_invoice);
    if (allocAmount <= 0) continue;
    allocatedTotal = money(allocatedTotal + allocAmount);
    billAllocations.push({
      name: row.invoice_number,
      billType: "Agst Ref",
      amount: allocAmount,
    });
  }

  const unallocated = money(amount - allocatedTotal);
  if (unallocated > 0) {
    billAllocations.push({
      name: "Advance",
      billType: "New Ref",
      amount: unallocated,
    });
  }

  const entries = [];
  const balanceRows = [];

  entries.push(
    ledgerEntry({
      ledgerName: paymentLedger,
      amount,
      isDebit: true,
    })
  );
  balanceRows.push({ signedAmount: -amount });

  entries.push(
    ledgerEntry({
      ledgerName: partyLedger,
      amount,
      isDebit: false,
      billAllocations,
    })
  );
  balanceRows.push({ signedAmount: amount });

  const xml = voucherBlock({
    vchType: "Receipt",
    date: receipt.receipt_date,
    voucherNumber: receipt.receipt_number,
    partyLedgerName: partyLedger,
    narration: `Customer receipt ${receipt.receipt_number}`,
    entries,
  });

  return {
    xml,
    partyLedger,
    paymentLedger,
    amount,
    balance: voucherBalance(balanceRows),
    preview: {
      voucher_type: "Receipt",
      voucher_number: receipt.receipt_number,
      voucher_date: receipt.receipt_date,
      party_ledger: partyLedger,
      payment_ledger: paymentLedger,
      amount,
      allocation_count: billAllocations.length,
    },
  };
}

async function fetchPostedReceipts(client, companyId, dateFrom, dateTo) {
  const r = await client.query(
    `
      select
        cr.id,
        cr.receipt_number,
        cr.receipt_date,
        cr.receipt_status,
        cr.customer_id,
        cr.receipt_amount_invoice,
        cr.receipt_amount_base,
        cr.payment_mode,
        cr.bank_name,
        cr.reference_no,
        c.customer_name,
        c.customer_code
      from customer_receipts cr
      join customers c on c.id = cr.customer_id
      where cr.company_id = $1
        and cr.receipt_status = 'posted'
        and coalesce(cr.receipt_source, '') <> 'tally_import'
        and cr.receipt_date >= $2::date
        and cr.receipt_date <= $3::date
      order by cr.receipt_date asc, cr.receipt_number asc
    `,
    [Number(companyId), dateFrom, dateTo]
  );
  return r.rows;
}

async function fetchReceiptAllocationsMap(client, receiptIds) {
  const ids = (Array.isArray(receiptIds) ? receiptIds : []).map(Number).filter((id) => id > 0);
  if (!ids.length) return new Map();
  const r = await client.query(
    `
      select
        cra.customer_receipt_id,
        cra.allocated_invoice,
        cra.allocated_base,
        ci.invoice_number
      from customer_receipt_allocations cra
      join customer_invoices ci on ci.id = cra.customer_invoice_id
      where cra.customer_receipt_id = any($1::int[])
      order by cra.customer_receipt_id asc, ci.invoice_number asc
    `,
    [ids]
  );
  const map = new Map();
  for (const row of r.rows) {
    const key = Number(row.customer_receipt_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function buildReceiptExport(client, companyId, dateFrom, dateTo, ledgers) {
  const receipts = await fetchPostedReceipts(client, companyId, dateFrom, dateTo);
  const allocMap = await fetchReceiptAllocationsMap(
    client,
    receipts.map((row) => row.id)
  );

  const vouchers = [];
  let totalAmount = 0;
  for (const receipt of receipts) {
    const allocations = allocMap.get(Number(receipt.id)) || [];
    const built = buildReceiptVoucherXml(receipt, allocations, ledgers);
    vouchers.push(built);
    totalAmount = money(totalAmount + built.amount);
  }

  return {
    receipts,
    vouchers,
    voucherCount: vouchers.length,
    totalAmount,
    sampleVoucher: vouchers[0]?.preview || null,
  };
}

module.exports = {
  buildReceiptVoucherXml,
  fetchPostedReceipts,
  fetchReceiptAllocationsMap,
  buildReceiptExport,
};
