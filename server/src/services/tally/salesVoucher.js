const { getCompanyProfile } = require("../companyProfile");
const { ledgerEntry, voucherBlock, voucherBalance } = require("./tallyXml");
const { money2: money, ROUND_OFF_LIMIT } = require("./money");

function cleanText(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function deriveStateCode(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
}

function normalizeStateName(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ");
}

function inferTaxMode(sellerProfile, invoice) {
  const sellerStateCode = cleanText(sellerProfile.state_code);
  const buyerStateCode =
    deriveStateCode(invoice.customer_gstin) ||
    cleanText(invoice.customer_state_code) ||
    deriveStateCode(invoice.customer_state_code);
  if (sellerStateCode && buyerStateCode) {
    return sellerStateCode === buyerStateCode ? "intra" : "inter";
  }
  const sellerState = normalizeStateName(sellerProfile.state);
  const buyerState = normalizeStateName(invoice.customer_state);
  if (sellerState && buyerState && sellerState === buyerState) return "intra";
  return "inter";
}

function summarizeInvoiceTax(invoice, lines, sellerProfile) {
  const taxMode = inferTaxMode(sellerProfile, invoice);
  let goodsTaxable = 0;
  let freightTaxable = 0;
  let pfTaxable = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  for (const line of lines) {
    const kind = cleanText(line.charge_kind);
    const taxable = money(line.line_total_invoice ?? num(line.qty) * num(line.unit_price_invoice));
    const gstPct = num(line.gst_pct);
    const gstAmount = money((taxable * gstPct) / 100);
    const lineCgst = taxMode === "intra" ? money(gstAmount / 2) : 0;
    const lineSgst = taxMode === "intra" ? money(gstAmount - lineCgst) : 0;
    const lineIgst = taxMode === "inter" ? gstAmount : 0;

    if (kind === "freight") freightTaxable = money(freightTaxable + taxable);
    else if (kind === "packing_forwarding") pfTaxable = money(pfTaxable + taxable);
    else goodsTaxable = money(goodsTaxable + taxable);

    cgst = money(cgst + lineCgst);
    sgst = money(sgst + lineSgst);
    igst = money(igst + lineIgst);
  }

  const computedGrand = money(goodsTaxable + freightTaxable + pfTaxable + cgst + sgst + igst);
  const grandTotal = money(invoice.grand_total_invoice) || computedGrand;
  const roundOff = money(grandTotal - computedGrand);
  const mismatch = Math.abs(roundOff) >= ROUND_OFF_LIMIT;

  return {
    taxMode,
    goodsTaxable,
    freightTaxable,
    pfTaxable,
    cgst,
    sgst,
    igst,
    computedGrand,
    grandTotal,
    roundOff,
    mismatch,
  };
}

function buildSalesVoucherXml(invoice, lines, sellerProfile, ledgers) {
  const summary = summarizeInvoiceTax(invoice, lines, sellerProfile);
  const partyLedger = ledgers.getParty(invoice.customer_id, invoice.customer_name);
  const salesLedger = ledgers.getScope("sales");
  const freightLedger = ledgers.getScope("freight");
  const pfLedger = ledgers.getScope("packing_forwarding");
  const cgstLedger = ledgers.getScope("output_cgst");
  const sgstLedger = ledgers.getScope("output_sgst");
  const igstLedger = ledgers.getScope("output_igst");
  const roundOffLedger = ledgers.getScope("round_off");

  const entries = [];
  const balanceRows = [];

  entries.push(
    ledgerEntry({
      ledgerName: partyLedger,
      amount: summary.grandTotal,
      isDebit: true,
    })
  );
  balanceRows.push({ signedAmount: -summary.grandTotal });

  if (summary.goodsTaxable > 0) {
    entries.push(ledgerEntry({ ledgerName: salesLedger, amount: summary.goodsTaxable, isDebit: false }));
    balanceRows.push({ signedAmount: summary.goodsTaxable });
  }
  if (summary.freightTaxable > 0) {
    entries.push(ledgerEntry({ ledgerName: freightLedger, amount: summary.freightTaxable, isDebit: false }));
    balanceRows.push({ signedAmount: summary.freightTaxable });
  }
  if (summary.pfTaxable > 0) {
    entries.push(ledgerEntry({ ledgerName: pfLedger, amount: summary.pfTaxable, isDebit: false }));
    balanceRows.push({ signedAmount: summary.pfTaxable });
  }
  if (summary.cgst > 0) {
    entries.push(ledgerEntry({ ledgerName: cgstLedger, amount: summary.cgst, isDebit: false }));
    balanceRows.push({ signedAmount: summary.cgst });
  }
  if (summary.sgst > 0) {
    entries.push(ledgerEntry({ ledgerName: sgstLedger, amount: summary.sgst, isDebit: false }));
    balanceRows.push({ signedAmount: summary.sgst });
  }
  if (summary.igst > 0) {
    entries.push(ledgerEntry({ ledgerName: igstLedger, amount: summary.igst, isDebit: false }));
    balanceRows.push({ signedAmount: summary.igst });
  }
  if (Math.abs(summary.roundOff) >= 0.01) {
    const isDebit = summary.roundOff < 0;
    entries.push(
      ledgerEntry({
        ledgerName: roundOffLedger,
        amount: Math.abs(summary.roundOff),
        isDebit,
      })
    );
    balanceRows.push({ signedAmount: summary.roundOff });
  }

  const xml = voucherBlock({
    vchType: "Sales",
    date: invoice.invoice_date,
    voucherNumber: invoice.invoice_number,
    partyLedgerName: partyLedger,
    narration: `Tax invoice ${invoice.invoice_number}`,
    entries,
  });

  return {
    xml,
    summary,
    partyLedger,
    balance: voucherBalance(balanceRows),
    preview: {
      voucher_type: "Sales",
      voucher_number: invoice.invoice_number,
      voucher_date: invoice.invoice_date,
      party_ledger: partyLedger,
      grand_total: summary.grandTotal,
      tax_mode: summary.taxMode,
    },
  };
}

async function fetchSalesInvoices(client, companyId, dateFrom, dateTo) {
  const r = await client.query(
    `
      select
        ci.id,
        ci.invoice_number,
        ci.invoice_date,
        ci.invoice_status,
        ci.customer_id,
        ci.grand_total_invoice,
        ci.grand_total_base,
        ci.subtotal_invoice,
        ci.tax_total_invoice,
        c.customer_name,
        c.customer_code,
        c.gstin as customer_gstin,
        c.state as customer_state
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      where ci.company_id = $1
        and ci.invoice_status in ('issued', 'paid')
        and coalesce(ci.invoice_source, '') <> 'tally_import'
        and ci.invoice_date >= $2::date
        and ci.invoice_date <= $3::date
      order by ci.invoice_date asc, ci.invoice_number asc
    `,
    [Number(companyId), dateFrom, dateTo]
  );
  return r.rows;
}

async function fetchInvoiceLinesMap(client, invoiceIds) {
  const ids = (Array.isArray(invoiceIds) ? invoiceIds : []).map(Number).filter((id) => id > 0);
  if (!ids.length) return new Map();
  const r = await client.query(
    `
      select
        il.*,
        pg.group_name as product_group_name
      from invoice_lines il
      left join products p on p.id = il.product_id
      left join product_groups pg on pg.id = p.group_id
      where il.customer_invoice_id = any($1::int[])
      order by il.customer_invoice_id asc, il.line_no asc
    `,
    [ids]
  );
  const map = new Map();
  for (const row of r.rows) {
    const key = Number(row.customer_invoice_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function buildSalesExport(client, companyId, dateFrom, dateTo, ledgers) {
  const sellerProfile = await getCompanyProfile(client, companyId);
  const invoices = await fetchSalesInvoices(client, companyId, dateFrom, dateTo);
  const linesMap = await fetchInvoiceLinesMap(
    client,
    invoices.map((row) => row.id)
  );

  const vouchers = [];
  const held = [];
  let totalAmount = 0;
  for (const invoice of invoices) {
    const lines = linesMap.get(Number(invoice.id)) || [];
    const built = buildSalesVoucherXml(invoice, lines, sellerProfile, ledgers);
    if (built.summary.mismatch) {
      held.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        invoice_total: built.summary.grandTotal,
        computed_from_lines: built.summary.computedGrand,
        difference: built.summary.roundOff,
        reason: `Header total differs from lines + GST by ${built.summary.roundOff.toFixed(2)} — fix the invoice before export`,
      });
      continue;
    }
    vouchers.push(built);
    totalAmount = money(totalAmount + built.summary.grandTotal);
  }

  return {
    invoices,
    vouchers,
    held,
    voucherCount: vouchers.length,
    totalAmount,
    sampleVoucher: vouchers[0]?.preview || null,
  };
}

module.exports = {
  inferTaxMode,
  summarizeInvoiceTax,
  buildSalesVoucherXml,
  fetchSalesInvoices,
  fetchInvoiceLinesMap,
  buildSalesExport,
};
