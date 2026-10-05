const { pool } = require("../db/pool");
const { getVendorComplianceStatus } = require("./vendorPortal");

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/**
 * Ensures system chart of accounts are mapped and returns account ID.
 */
async function getOrCreateGlAccount(client, companyId, accountCode, fallbackName, accountType, balance) {
  const res = await client.query(
    `select id from chart_of_accounts where company_id = $1 and account_code = $2 limit 1`,
    [companyId, accountCode]
  );
  if (res.rows[0]) return Number(res.rows[0].id);

  const ins = await client.query(
    `
      insert into chart_of_accounts (company_id, account_code, account_name, account_type, normal_balance)
      values ($1, $2, $3, $4, $5)
      returning id
    `,
    [companyId, accountCode, fallbackName, accountType, balance]
  );
  return Number(ins.rows[0].id);
}

/**
 * Posts double entry into general_ledger_entries.
 */
async function postGlDoubleEntry(client, {
  companyId,
  entryNumber,
  entryDate = new Date(),
  sourceEvent,
  refType,
  refId,
  debitAccountId,
  creditAccountId,
  amount,
  narration,
  userId = null,
}) {
  const amt = money(amount);
  if (amt <= 0) return null;

  // 1. Debit leg
  const drRes = await client.query(
    `
      insert into general_ledger_entries (
        company_id, entry_number, account_id, entry_date,
        source_event, ref_type, ref_id, debit, credit, narration, created_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10)
      returning id
    `,
    [companyId, `${entryNumber}-DR`, debitAccountId, entryDate, sourceEvent, refType, refId, amt, narration, userId]
  );

  // 2. Credit leg
  await client.query(
    `
      insert into general_ledger_entries (
        company_id, entry_number, account_id, entry_date,
        source_event, ref_type, ref_id, debit, credit, narration, created_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)
    `,
    [companyId, `${entryNumber}-CR`, creditAccountId, entryDate, sourceEvent, refType, refId, amt, narration, userId]
  );

  return drRes.rows[0]?.id || null;
}

/**
 * Generates an automated Customer Tax Invoice from an outbound Dispatch.
 * Posts AR debit and Sales Revenue + Output GST credits to GL.
 */
async function generateInvoiceFromDispatch(client, {
  companyId,
  dispatchId,
  userId = null,
}) {
  // Load Dispatch details
  const dRes = await client.query(
    `
      select
        d.*,
        so.base_currency_id,
        so.order_currency_id,
        so.subtotal_base,
        so.subtotal_order,
        so.tax_total_base,
        so.tax_total_order,
        so.grand_total_base,
        so.grand_total_order,
        c.gstin as customer_gstin,
        c.credit_days
      from dispatches d
      join sales_orders so on so.id = d.sales_order_id
      join customers c on c.id = d.customer_id
      where d.id = $1 and (d.company_id = $2 or d.company_id is null)
      limit 1
    `,
    [dispatchId, companyId]
  );
  const dispatch = dRes.rows[0];
  if (!dispatch) {
    const err = new Error("DISPATCH_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  // Check if invoice already exists
  const existRes = await client.query(
    `select id, invoice_number from customer_invoices where dispatch_id = $1 or sales_order_id = $2 limit 1`,
    [dispatchId, dispatch.sales_order_id]
  );
  if (existRes.rows[0]) {
    return { already_invoiced: true, invoice: existRes.rows[0] };
  }

  // Generate Invoice Number
  const numRes = await client.query(`select next_company_document_number($1, 'INV') as num`, [companyId]);
  const invoiceNumber = numRes.rows[0]?.num || `INV-${Date.now().toString(36).toUpperCase()}`;

  // Derive tax split (Interstate vs Intrastate)
  const isInterstate = dispatch.customer_gstin && !String(dispatch.customer_gstin).startsWith("07"); // 07 is Delhi origin
  const taxTotal = money(dispatch.tax_total_base);
  const subtotal = money(dispatch.subtotal_base);
  const grandTotal = money(dispatch.grand_total_base);

  const cgst = isInterstate ? 0 : money(taxTotal / 2);
  const sgst = isInterstate ? 0 : money(taxTotal / 2);
  const igst = isInterstate ? taxTotal : 0;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + Number(dispatch.credit_days || 30));

  // Insert Customer Invoice
  const invRes = await client.query(
    `
      insert into customer_invoices (
        company_id, invoice_number, sales_order_id, dispatch_id, customer_id, distributor_id,
        invoice_status, invoice_date, due_date, base_currency_id, invoice_currency_id,
        subtotal_base, subtotal_invoice, tax_total_base, tax_total_invoice,
        grand_total_base, grand_total_invoice, balance_due, paid_amount,
        cgst_amount, sgst_amount, igst_amount, is_interstate, customer_gstin,
        attention_to, remarks, created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, 'issued', current_date, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, 0,
        $17, $18, $19, $20, $21, $22, $23, $24
      )
      returning *
    `,
    [
      companyId,
      invoiceNumber,
      dispatch.sales_order_id,
      dispatch.id,
      dispatch.customer_id,
      dispatch.distributor_id,
      dueDate,
      dispatch.base_currency_id || 1,
      dispatch.invoice_currency_id || 1,
      subtotal,
      dispatch.subtotal_order || subtotal,
      taxTotal,
      dispatch.tax_total_order || taxTotal,
      grandTotal,
      dispatch.grand_total_order || grandTotal,
      grandTotal, // balance_due
      cgst,
      sgst,
      igst,
      Boolean(isInterstate),
      dispatch.customer_gstin,
      dispatch.consignee_name,
      `Tax invoice generated from Outbound Dispatch ${dispatch.dispatch_number}`,
      userId,
    ]
  );
  const createdInvoice = invRes.rows[0];

  // Copy Lines
  const dlRes = await client.query(
    `
      select dl.*, sol.unit_price_base, sol.unit_price_order, sol.line_total_base, sol.hsn_no, sol.product_id
      from dispatch_lines dl
      join sales_order_lines sol on sol.id = dl.sales_order_line_id
      where dl.dispatch_id = $1
      order by dl.line_no asc
    `,
    [dispatchId]
  );
  for (const line of dlRes.rows) {
    await client.query(
      `
        insert into invoice_lines (
          customer_invoice_id, sales_order_line_id, line_no, product_id,
          item_code, item_name, line_description, hsn_no, qty,
          unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        createdInvoice.id,
        line.sales_order_line_id,
        line.line_no,
        line.product_id,
        line.item_code,
        line.item_name,
        line.line_description,
        line.hsn_no || "84051000",
        line.qty_dispatch,
        line.unit_price_base,
        line.unit_price_order || line.unit_price_base,
        line.gst_pct,
        line.line_total_base,
        line.line_total_base,
      ]
    );
  }

  // Double Entry GL: Debit Accounts Receivable (1100), Credit Sales Revenue (4100) & GST Output (2200)
  const arAcctId = await getOrCreateGlAccount(client, companyId, "1100", "Accounts Receivable (Trade Debtors)", "asset", "debit");
  const revAcctId = await getOrCreateGlAccount(client, companyId, "4100", "Sales Revenue", "revenue", "credit");
  const gstOutAcctId = await getOrCreateGlAccount(client, companyId, "2200", "GST Output Tax Liability", "liability", "credit");

  // Post Subtotal to Revenue
  const glEntryId = await postGlDoubleEntry(client, {
    companyId,
    entryNumber: `GL-${invoiceNumber}`,
    entryDate: new Date(),
    sourceEvent: "SALES_INVOICE",
    refType: "customer_invoices",
    refId: createdInvoice.id,
    debitAccountId: arAcctId,
    creditAccountId: revAcctId,
    amount: subtotal,
    narration: `Invoice ${invoiceNumber} AR booking for ${dispatch.consignee_name || "Customer"}`,
    userId,
  });

  // Post Tax to Output GST
  if (taxTotal > 0) {
    await postGlDoubleEntry(client, {
      companyId,
      entryNumber: `GL-${invoiceNumber}-TAX`,
      entryDate: new Date(),
      sourceEvent: "SALES_INVOICE",
      refType: "customer_invoices",
      refId: createdInvoice.id,
      debitAccountId: arAcctId,
      creditAccountId: gstOutAcctId,
      amount: taxTotal,
      narration: `Output GST on Invoice ${invoiceNumber}`,
      userId,
    });
  }

  // Link GL entry to invoice
  await client.query(`update customer_invoices set ar_gl_entry_id = $1 where id = $2`, [glEntryId, createdInvoice.id]);

  return { already_invoiced: false, invoice: createdInvoice };
}

/**
 * 3-Way Match Validation Engine for Accounts Payable (AP).
 * Validates Vendor Bill against PO quantities/rates and GRN goods receipt.
 */
async function validateAndProcessVendorBill(client, {
  companyId,
  vendorId,
  purchaseOrderId,
  goodsReceiptId = null,
  vendorInvoiceRef,
  billDate = new Date(),
  lines = [],
  userId = null,
}) {
  // 1. Check Vendor Statutory Compliance Lock
  const compliance = await getVendorComplianceStatus(client, vendorId);
  if (compliance.locked) {
    const err = new Error("VENDOR_COMPLIANCE_LOCKED");
    err.status = 400;
    err.detail = "Vendor statutory compliance documents are expired or unverified. Vendor Bill is on hold.";
    err.compliance = compliance;
    throw err;
  }

  // 2. Load PO Context
  const poRes = await client.query(
    `
      select po.*, v.company_name as vendor_name
      from purchase_orders po
      join vendors v on v.id = po.vendor_id
      where po.id = $1 and po.company_id = $2
      limit 1
    `,
    [purchaseOrderId, companyId]
  );
  const po = poRes.rows[0];
  if (!po) {
    const err = new Error("PURCHASE_ORDER_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  // Load PO Lines
  const polRes = await client.query(
    `select id, item_code, item_name, unit_price_base, qty from purchase_order_lines where purchase_order_id = $1`,
    [purchaseOrderId]
  );
  const poLinesMap = new Map(polRes.rows.map((p) => [String(p.item_code).trim().toUpperCase(), p]));

  // 3. Load GRN lines if goodsReceiptId provided
  let grnLinesMap = new Map();
  if (goodsReceiptId) {
    const grnRes = await client.query(
      `select grl.id, grl.item_code, grl.qty_received from goods_receipt_lines grl where grl.goods_receipt_id = $1`,
      [goodsReceiptId]
    );
    grnLinesMap = new Map(grnRes.rows.map((g) => [String(g.item_code).trim().toUpperCase(), Number(g.qty_received || 0)]));
  }

  // 4. Perform 3-Way Match Verification
  let matchStatus = "matched_ok";
  let matchNotes = "3-Way Match Passed (PO vs. GRN vs. Bill)";
  let subtotal = 0;
  let taxTotal = 0;

  const processedLines = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const l = lines[idx];
    const codeKey = String(l.item_code || "").trim().toUpperCase();
    const poLine = poLinesMap.get(codeKey);

    const billedQty = qty(l.qty_billed);
    const billedRate = money(l.unit_price_billed);
    const gstPct = Number(l.gst_pct || 18);
    const lineTotal = money(billedQty * billedRate);
    const lineTax = money(lineTotal * (gstPct / 100));

    subtotal += lineTotal;
    taxTotal += lineTax;

    // Price Verification (Check if billed rate exceeds PO rate by > 1%)
    if (poLine && billedRate > Number(poLine.unit_price_base) * 1.01) {
      matchStatus = "price_mismatch";
      matchNotes = `Unit price mismatch on item ${l.item_code} (PO: ₹${poLine.unit_price_base}, Billed: ₹${billedRate})`;
    }

    // Quantity Verification against GRN if linked
    if (goodsReceiptId && grnLinesMap.has(codeKey)) {
      const receivedQty = grnLinesMap.get(codeKey);
      if (billedQty > receivedQty) {
        matchStatus = "qty_mismatch";
        matchNotes = `Billed qty exceeds received GRN qty for ${l.item_code} (GRN: ${receivedQty}, Billed: ${billedQty})`;
      }
    }

    processedLines.push({
      line_no: idx + 1,
      item_code: l.item_code,
      item_name: l.item_name || poLine?.item_name || "Item",
      hsn_no: l.hsn_no || "84051000",
      qty_billed: billedQty,
      unit_price_billed: billedRate,
      gst_pct: gstPct,
      line_total: lineTotal,
    });
  }

  const grandTotal = money(subtotal + taxTotal);
  const numRes = await client.query(`select next_company_document_number($1, 'BILL') as num`, [companyId]);
  const billNumber = numRes.rows[0]?.num || `BILL-${Date.now().toString(36).toUpperCase()}`;

  // 5. Insert Vendor Bill
  const billRes = await client.query(
    `
      insert into vendor_bills (
        company_id, bill_number, vendor_id, purchase_order_id, goods_receipt_id,
        vendor_invoice_ref, bill_date, due_date, subtotal, tax_total, grand_total,
        match_status, payment_status, statutory_verified, match_notes, created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unpaid', true, $13, $14
      )
      returning *
    `,
    [
      companyId,
      billNumber,
      vendorId,
      purchaseOrderId,
      goodsReceiptId,
      vendorInvoiceRef,
      billDate,
      new Date(Date.now() + 30 * 86400000), // Net 30 default
      subtotal,
      taxTotal,
      grandTotal,
      matchStatus,
      matchNotes,
      userId,
    ]
  );
  const bill = billRes.rows[0];

  for (const pl of processedLines) {
    await client.query(
      `
        insert into vendor_bill_lines (
          vendor_bill_id, line_no, item_code, item_name, hsn_no,
          qty_billed, unit_price_billed, gst_pct, line_total
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        bill.id,
        pl.line_no,
        pl.item_code,
        pl.item_name,
        pl.hsn_no,
        pl.qty_billed,
        pl.unit_price_billed,
        pl.gst_pct,
        pl.line_total,
      ]
    );
  }

  // 6. If matched_ok, post to GL: Debit Inventory/COGS (1200) & GST ITC (1300), Credit Accounts Payable (2100)
  if (matchStatus === "matched_ok") {
    const cogsAcctId = await getOrCreateGlAccount(client, companyId, "5100", "Cost of Goods Sold (COGS)", "expense", "debit");
    const itcAcctId = await getOrCreateGlAccount(client, companyId, "1300", "GST Input Tax Credit (ITC Receivable)", "asset", "debit");
    const apAcctId = await getOrCreateGlAccount(client, companyId, "2100", "Accounts Payable (Trade Creditors)", "liability", "credit");

    const glEntryId = await postGlDoubleEntry(client, {
      companyId,
      entryNumber: `GL-${billNumber}`,
      entryDate: new Date(),
      sourceEvent: "VENDOR_BILL",
      refType: "vendor_bills",
      refId: bill.id,
      debitAccountId: cogsAcctId,
      creditAccountId: apAcctId,
      amount: subtotal,
      narration: `AP booking for Vendor Bill ${billNumber} / Ref: ${vendorInvoiceRef}`,
      userId,
    });

    if (taxTotal > 0) {
      await postGlDoubleEntry(client, {
        companyId,
        entryNumber: `GL-${billNumber}-ITC`,
        entryDate: new Date(),
        sourceEvent: "VENDOR_BILL",
        refType: "vendor_bills",
        refId: bill.id,
        debitAccountId: itcAcctId,
        creditAccountId: apAcctId,
        amount: taxTotal,
        narration: `Input Tax Credit (ITC) on Vendor Bill ${billNumber}`,
        userId,
      });
    }

    await client.query(`update vendor_bills set ap_gl_entry_id = $1 where id = $2`, [glEntryId, bill.id]);
  }

  return { bill, matchStatus, matchNotes };
}

/**
 * Returns Real-time GST & Tax Reconciliation Metrics (Output Tax vs Input Tax Credit).
 */
async function getGstReconciliationSummary(client, companyId, { dateTo = null } = {}) {
  const invoiceParams = [companyId];
  const invoiceDate = dateTo ? `and invoice_date::date <= $2::date` : "";
  if (dateTo) invoiceParams.push(dateTo);

  // Output GST from Invoices
  const outRes = await client.query(
    `
      select
        coalesce(sum(cgst_amount), 0) as total_cgst,
        coalesce(sum(sgst_amount), 0) as total_sgst,
        coalesce(sum(igst_amount), 0) as total_igst,
        coalesce(sum(tax_total_base), 0) as total_output_tax,
        count(*) as invoice_count
      from customer_invoices
      where company_id = $1
        and lower(coalesce(invoice_status, '')) in ('issued', 'sent', 'posted', 'paid', 'partially_paid')
        ${invoiceDate}
    `,
    invoiceParams
  );

  const billParams = [companyId];
  const billDate = dateTo ? `and bill_date::date <= $2::date` : "";
  if (dateTo) billParams.push(dateTo);

  // Input GST (ITC) from Verified Vendor Bills
  const inRes = await client.query(
    `
      select
        coalesce(sum(tax_total), 0) as total_itc_tax,
        count(*) as bill_count
      from vendor_bills
      where company_id = $1
        and match_status = 'matched_ok'
        ${billDate}
    `,
    billParams
  );

  const outputTax = money(outRes.rows[0]?.total_output_tax);
  const inputTaxCredit = money(inRes.rows[0]?.total_itc_tax);
  let netGstPayable = money(Math.max(0, outputTax - inputTaxCredit));
  let itcCarryForward = money(Math.max(0, inputTaxCredit - outputTax));
  let gstPaid = 0;
  let source = "invoices_and_bills";

  try {
    const tallyParams = [companyId];
    const tallyDate = dateTo ? `and gle.entry_date::date <= $2::date` : "";
    if (dateTo) tallyParams.push(dateTo);
    const tallyRes = await client.query(
      `
        select
          coalesce(sum(case when coa.account_code = '2200' then gle.credit - gle.debit else 0 end), 0) as output_tax,
          coalesce(sum(case when coa.account_code = '1300' then gle.debit - gle.credit else 0 end), 0) as input_tax,
          coalesce(sum(case when coa.account_code = '2210' then gle.debit - gle.credit else 0 end), 0) as gst_paid
        from general_ledger_entries gle
        join chart_of_accounts coa on coa.id = gle.account_id
        where gle.company_id = $1
          and gle.source_event = 'TALLY_GST_SYNC'
          ${tallyDate}
      `,
      tallyParams
    );
    const tallyOutput = money(tallyRes.rows[0]?.output_tax);
    const tallyInput = money(tallyRes.rows[0]?.input_tax);
    const tallyPaid = money(tallyRes.rows[0]?.gst_paid);
    if (Math.abs(tallyOutput) > 0.01 || Math.abs(tallyInput) > 0.01 || Math.abs(tallyPaid) > 0.01) {
      gstPaid = tallyPaid;
      const tallyNet = money(tallyOutput - tallyInput - tallyPaid);
      netGstPayable = money(Math.max(0, tallyNet));
      itcCarryForward = money(Math.max(0, -tallyNet));
      source = "tally_ledgers";
      return {
        output_tax: {
          cgst: money(outRes.rows[0]?.total_cgst),
          sgst: money(outRes.rows[0]?.total_sgst),
          igst: money(outRes.rows[0]?.total_igst),
          total: tallyOutput,
          invoice_count: Number(outRes.rows[0]?.invoice_count || 0),
        },
        input_tax_credit: {
          total: tallyInput,
          bill_count: Number(inRes.rows[0]?.bill_count || 0),
        },
        gst_paid: gstPaid,
        net_gst_liability: netGstPayable,
        itc_carry_forward: itcCarryForward,
        source,
      };
    }
  } catch (_e) {
    /* keep invoice-based GST */
  }

  return {
    output_tax: {
      cgst: money(outRes.rows[0]?.total_cgst),
      sgst: money(outRes.rows[0]?.total_sgst),
      igst: money(outRes.rows[0]?.total_igst),
      total: outputTax,
      invoice_count: Number(outRes.rows[0]?.invoice_count || 0),
    },
    input_tax_credit: {
      total: inputTaxCredit,
      bill_count: Number(inRes.rows[0]?.bill_count || 0),
    },
    gst_paid: gstPaid,
    net_gst_liability: netGstPayable,
    itc_carry_forward: itcCarryForward,
    source,
  };
}

module.exports = {
  getOrCreateGlAccount,
  postGlDoubleEntry,
  generateInvoiceFromDispatch,
  validateAndProcessVendorBill,
  getGstReconciliationSummary,
};
