const {
  parseTallyData,
  enrichTallyInvoiceFromVoucherRaw,
  enrichTallyInvoicesFromVouchers,
  enrichTallyReceiptFromVoucherRaw,
  isTallySalesVoucher,
  isTallyReceiptVoucher,
} = require("./tallyEngine");

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/** Dedupe comma-separated job refs from SO report (e.g. N111,N111,N112 -> N111,N112). */
function normalizeJobNo(value) {
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = part.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(",") || null;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => String(cell || "").trim())) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((cell) => String(cell || "").trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseInvoiceChainCsv(text) {
  const rows = parseCsvText(text);
  if (!rows.length) return [];

  const header = rows[0].map(normalizeHeader);
  const dataRows = rows.slice(1);
  const indexFor = (...names) => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const invoiceIdx = indexFor("invoice_number", "invoice_no", "invoice", "tally_voucher_number", "voucher_number");
  const soIdx = indexFor("so_number", "sales_order_number", "sales_order", "so");
  const poIdx = indexFor("customer_po_number", "po_number", "customer_po", "buyer_po_number", "po");
  const poDateIdx = indexFor("customer_po_date", "po_date", "buyer_po_date");
  const jobIdx = indexFor("job_no", "job_number", "jobno", "job");

  if (invoiceIdx < 0 || soIdx < 0) {
    throw new Error("CSV must include invoice_number and so_number columns");
  }

  return dataRows
    .map((cells) => ({
      invoice_number: cleanText(cells[invoiceIdx]),
      so_number: cleanText(cells[soIdx]),
      customer_po_number: poIdx >= 0 ? cleanText(cells[poIdx]) : null,
      customer_po_date: poDateIdx >= 0 ? cleanText(cells[poDateIdx]) : null,
      job_no: jobIdx >= 0 ? normalizeJobNo(cells[jobIdx]) : null,
    }))
    .filter((row) => row.invoice_number && row.so_number);
}

async function linkInvoicesToSalesOrders(client, { companyId, rows }) {
  const results = [];
  for (const row of rows) {
    const invRes = await client.query(
      `
        select id, invoice_number, sales_order_id, customer_po_number
        from customer_invoices
        where company_id = $1
          and (
            lower(trim(invoice_number)) = lower(trim($2))
            or lower(trim(coalesce(tally_voucher_number, ''))) = lower(trim($2))
          )
        limit 1
      `,
      [companyId, row.invoice_number]
    );
    const invoice = invRes.rows[0];
    if (!invoice) {
      results.push({ ...row, ok: false, error: "INVOICE_NOT_FOUND" });
      continue;
    }

    const soRes = await client.query(
      `
        select id, so_number
        from sales_orders
        where company_id = $1
          and lower(trim(so_number)) = lower(trim($2))
        limit 1
      `,
      [companyId, row.so_number]
    );
    const salesOrder = soRes.rows[0];
    if (!salesOrder) {
      results.push({ ...row, ok: false, error: "SALES_ORDER_NOT_FOUND", invoice_id: invoice.id });
      continue;
    }

    await client.query(
      `
        update customer_invoices
        set
          sales_order_id = $2,
          customer_po_number = coalesce($3, customer_po_number),
          customer_po_date = coalesce($4::date, customer_po_date),
          job_no = coalesce($5, job_no),
          updated_at = now()
        where id = $1
      `,
      [invoice.id, salesOrder.id, row.customer_po_number, row.customer_po_date, row.job_no || null]
    );

    if (row.job_no) {
      await client.query(
        `
          update sales_orders
          set job_no = coalesce($2, job_no), updated_at = now()
          where id = $1
        `,
        [salesOrder.id, row.job_no]
      );
    }

    results.push({
      ...row,
      ok: true,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      sales_order_id: salesOrder.id,
      so_number: salesOrder.so_number,
      job_no: row.job_no || null,
      previous_sales_order_id: invoice.sales_order_id,
    });
  }
  return results;
}

async function enrichTallyInvoicesFromStaging(client, companyId) {
  const staged = await client.query(
    `
      select source_identifier, raw_payload
      from tally_staging_area
      where company_id = $1
        and record_type = 'voucher'
        and raw_payload is not null
      order by id desc
    `,
    [companyId]
  );

  const results = [];
  for (const row of staged.rows) {
    const raw = row.raw_payload || {};
    if (!isTallySalesVoucher(raw.voucher_type)) continue;
    try {
      results.push(await enrichTallyInvoiceFromVoucherRaw(client, companyId, raw));
    } catch (err) {
      results.push({
        ok: false,
        voucher_number: raw.voucher_number || row.source_identifier || null,
        error: err?.message || String(err),
      });
    }
  }
  return results;
}

async function enrichTallyInvoicesFromTallyFile(client, companyId, fileBuffer, fileName = "") {
  const parsed = parseTallyData(fileBuffer, fileName);
  const invoiceResults = await enrichTallyInvoicesFromVouchers(client, companyId, parsed.vouchers || []);

  const receiptResults = [];
  for (const raw of parsed.vouchers || []) {
    if (!isTallyReceiptVoucher(raw.voucher_type)) continue;
    try {
      receiptResults.push(await enrichTallyReceiptFromVoucherRaw(client, companyId, raw));
    } catch (err) {
      receiptResults.push({
        ok: false,
        voucher_number: raw.voucher_number || null,
        error: err?.message || String(err),
      });
    }
  }

  return {
    invoice_results: invoiceResults,
    receipt_results: receiptResults,
    invoices_updated: invoiceResults.filter((row) => row.ok).length,
    receipts_updated: receiptResults.filter((row) => row.ok).length,
    vouchers_parsed: (parsed.vouchers || []).length,
  };
}

async function backfillTallyInvoicePoFromStaging(client, companyId) {
  return enrichTallyInvoicesFromStaging(client, companyId);
}

module.exports = {
  parseInvoiceChainCsv,
  linkInvoicesToSalesOrders,
  normalizeJobNo,
  enrichTallyInvoicesFromStaging,
  enrichTallyInvoicesFromTallyFile,
  backfillTallyInvoicePoFromStaging,
};
