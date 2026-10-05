/**
 * Targeted Tally ledger sync: receipts (including On Account FIFO),
 * purchase bills + payments, and bank/cash books — without re-importing sales invoices.
 */
const {
  calculateSimilarity,
  createJoshReceiptFromTallyVoucher,
  extractTaxFromLedgerEntries,
  isTallyReceiptVoucher,
  parseTallyData,
  resolveCompany,
  resolveOrCreateCustomerForParty,
} = require("./tallyEngine");
const { getOrCreateGlAccount } = require("./financeAccounting");

const SYNC_NOTE = "tally_ledger_sync";
const SOURCE_EVENT = "TALLY_LEDGER_SYNC";
const GST_SOURCE_EVENT = "TALLY_GST_SYNC";
const AP_SOURCE_EVENT = "TALLY_AP_SYNC";
const AP_CLOSE_NOTE = "tally_ap_ledger_close";
const FIFO_MATCH_MIN = 0.88;
const FIFO_MATCH_LEAD = 0.05;
const LEGAL_SUFFIX_RE =
  /\b((private|pvt)\.?(\s+(limited|ltd)\.?)?|limited|ltd|llp|llc|inc|corp(oration)?|opc)\b\.?/gi;

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function typeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isPurchaseVoucher(type) {
  const t = typeKey(type);
  return t.includes("purchase") && !t.includes("order");
}

function isPaymentVoucher(type) {
  return typeKey(type).includes("payment") && !typeKey(type).includes("receipt");
}

function isContraOrJournal(type) {
  const t = typeKey(type);
  return t === "contra" || t === "journal" || t.includes("audit entry");
}

function isDebitNote(type) {
  const t = typeKey(type);
  return t.includes("debit note") || t === "d/note";
}

function isCreditNote(type) {
  const t = typeKey(type);
  return t.includes("credit note") || t === "c/note";
}

function decodePartyName(name) {
  return String(name || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function isApExcludedLedger(name) {
  const lower = decodePartyName(name).toLowerCase();
  if (!lower) return true;
  if (isBankCashLedger(name)) return true;
  if (isTallyGstLedger(name)) return true;
  return (
    /\b(cgst|sgst|igst|gst|tds|tcs|vat|cess)\b/.test(lower) ||
    lower.includes("round off") ||
    lower.includes("profit") ||
    lower.includes("loss") ||
    lower.includes("short") ||
    lower.includes("excess") ||
    /^purchase\b/.test(lower) ||
    /^sales\b/.test(lower) ||
    lower.includes("stock") ||
    lower.includes("duty") ||
    lower.includes("freight") ||
    lower.includes("transport") ||
    lower.includes("packing") ||
    lower.includes("discount")
  );
}

function isApVoucherKind(type) {
  return (
    isPurchaseVoucher(type) ||
    isPaymentVoucher(type) ||
    isDebitNote(type) ||
    isCreditNote(type)
  );
}

function computeTallyApPosition(vouchers) {
  const byParty = {};
  let maxDate = null;
  for (const raw of vouchers || []) {
    if (!isApVoucherKind(raw.voucher_type)) continue;
    if (raw.date && (!maxDate || raw.date > maxDate)) maxDate = raw.date;
    for (const entry of raw.entries || []) {
      const name = decodePartyName(entry.ledger_name);
      if (isApExcludedLedger(name)) continue;
      const amt = money(entry.amount);
      if (amt <= 0) continue;
      // Liability: credit increases AP, debit decreases AP
      const delta = entry.is_debit ? -amt : amt;
      byParty[name] = money((byParty[name] || 0) + delta);
    }
  }
  const openParties = {};
  let net = 0;
  let partyCount = 0;
  for (const [name, bal] of Object.entries(byParty)) {
    const open = money(bal);
    if (open > 0.01) {
      openParties[name] = open;
      net = money(net + open);
      partyCount += 1;
    }
  }
  return {
    net,
    party_count: partyCount,
    by_party: openParties,
    as_of: maxDate,
  };
}

function isBankCashLedger(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return false;
  if (/loan|interest|charges|insurance|lombard|inelligible|ineligible|accrude|accrued/.test(lower)) {
    return false;
  }
  if (lower === "cash") return true;
  if (/^icici bank\b/.test(lower) && /\d{6,}/.test(lower)) return true;
  if (/^hdfc bank\b/.test(lower) && !/loan/.test(lower)) return true;
  if (/^(axis bank|state bank|sbi|kotak|yes bank|idfc)\b/.test(lower)) return true;
  return false;
}

function isSkipParty(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return true;
  if (isBankCashLedger(name)) return true;
  return (
    /\b(cgst|sgst|igst|gst|tds|tcs)\b/.test(lower) ||
    lower.includes("round off") ||
    lower.includes("profit") ||
    lower.includes("loss")
  );
}

function bankBookType(name) {
  return String(name || "").trim().toLowerCase() === "cash" ? "cash" : "bank";
}

function bankLineAmount(entry) {
  return money(entry?.amount);
}

function bankLineIsDebit(entry) {
  return Boolean(entry?.is_debit);
}

function partyCoreKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIX_RE, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeGstin(value) {
  const g = String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return g.length >= 12 ? g : "";
}

function partyMatchScore(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return { score: 0, method: "none" };
  const ca = partyCoreKey(left);
  const cb = partyCoreKey(right);
  if (ca && cb && ca === cb) return { score: 1, method: "legal_core" };
  const sim = calculateSimilarity(left, right);
  const coreSim = ca && cb ? calculateSimilarity(ca, cb) : 0;
  let score = Math.max(sim, coreSim);
  let method = score >= FIFO_MATCH_MIN ? "fuzzy" : "weak";
  if (ca && cb && (ca.includes(cb) || cb.includes(ca))) {
    const ratio = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length);
    if (ratio >= 0.72 && Math.min(ca.length, cb.length) >= 6) {
      score = Math.max(score, Number((0.86 + 0.14 * ratio).toFixed(4)));
      method = "contain";
    }
  }
  return { score, method };
}

function matchReceiptToInvoiceParty(receiptName, invoiceName, receiptGstin, invoiceGstin) {
  const g1 = normalizeGstin(receiptGstin);
  const g2 = normalizeGstin(invoiceGstin);
  if (g1 && g1 === g2) return { score: 1, method: "gstin" };
  const m = partyMatchScore(receiptName, invoiceName);
  if (m.score >= FIFO_MATCH_MIN) return m;
  return null;
}

function pickBestInvoiceMatches(receiptName, receiptGstin, invoices) {
  const scored = [];
  for (const inv of invoices) {
    const match = matchReceiptToInvoiceParty(
      receiptName,
      inv.customer_name,
      receiptGstin,
      inv.gstin
    );
    if (!match) continue;
    scored.push({ inv, ...match });
  }
  if (!scored.length) return [];
  const byCustomer = new Map();
  for (const row of scored) {
    const key = String(row.inv.customer_id);
    const cur = byCustomer.get(key);
    if (!cur || row.score > cur.score) byCustomer.set(key, row);
  }
  const ranked = [...byCustomer.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (second && best.score - second.score < FIFO_MATCH_LEAD && best.method !== "gstin") {
    const sameCore = partyCoreKey(best.inv.customer_name) === partyCoreKey(second.inv.customer_name);
    if (!sameCore) return [];
  }
  const allowed = new Set(
    ranked
      .filter((row) => {
        if (row.score >= best.score - 0.001) return true;
        return partyCoreKey(row.inv.customer_name) === partyCoreKey(best.inv.customer_name);
      })
      .map((row) => String(row.inv.customer_id))
  );
  return scored
    .filter((row) => allowed.has(String(row.inv.customer_id)))
    .sort((a, b) => {
      const da = invoiceDateKey(a.inv.invoice_date);
      const db = invoiceDateKey(b.inv.invoice_date);
      if (da !== db) return da.localeCompare(db);
      return Number(a.inv.id) - Number(b.inv.id);
    });
}

function invoiceDateKey(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function isTallyGstLedger(name) {
  const n = String(name || "").trim();
  if (/^(output|input)\s+(cgst|sgst|igst)(\s*-?\s*rcm)?$/i.test(n)) return true;
  if (/^cash\s*-\s*(cgst|sgst|igst)$/i.test(n)) return true;
  return false;
}

function isTallyInputGstLedger(name) {
  return /^input\s+(cgst|sgst|igst)(\s*-?\s*rcm)?$/i.test(String(name || "").trim());
}

function isTallyCashGstLedger(name) {
  return /^cash\s*-\s*(cgst|sgst|igst)$/i.test(String(name || "").trim());
}

function isTallyOutputGstLedger(name) {
  return /^output\s+(cgst|sgst|igst)(\s*-?\s*rcm)?$/i.test(String(name || "").trim());
}

function computeTallyGstPosition(vouchers) {
  const byLedger = {};
  let output = 0;
  let input = 0;
  let cashGst = 0;
  let maxDate = null;
  for (const raw of vouchers || []) {
    if (raw.date && (!maxDate || raw.date > maxDate)) maxDate = raw.date;
    for (const entry of raw.entries || []) {
      const name = entry.ledger_name || "";
      if (!isTallyGstLedger(name)) continue;
      const amt = money(entry.amount);
      if (amt <= 0) continue;
      const liabilityDelta = entry.is_debit ? -amt : amt;
      const assetDelta = entry.is_debit ? amt : -amt;
      byLedger[name] = money((byLedger[name] || 0) + liabilityDelta);
      if (isTallyInputGstLedger(name)) input += assetDelta;
      else if (isTallyCashGstLedger(name)) cashGst += liabilityDelta;
      else if (isTallyOutputGstLedger(name)) output += liabilityDelta;
    }
  }
  const cashPaid = money(Math.max(0, -cashGst));
  const net = money(output - input + cashGst);
  return {
    output: money(output),
    input: money(input),
    cash_gst: money(cashGst),
    paid: cashPaid,
    net,
    by_ledger: Object.fromEntries(
      Object.entries(byLedger).map(([k, v]) => [k, money(v)])
    ),
    as_of: maxDate,
  };
}

async function syncInvoicePaidAmounts(client, companyId, invoiceIds = null) {
  const params = [companyId];
  let idFilter = "";
  if (Array.isArray(invoiceIds) && invoiceIds.length) {
    params.push(invoiceIds);
    idFilter = `and ci.id = any($2::int[])`;
  }
  const r = await client.query(
    `
      with alloc as (
        select
          ci.id,
          coalesce(nullif(ci.grand_total_invoice, 0), ci.grand_total_base, 0) as grand,
          coalesce(sum(cra.allocated_invoice), 0) as allocated
        from customer_invoices ci
        left join customer_receipt_allocations cra on cra.customer_invoice_id = ci.id
        left join customer_receipts cr
          on cr.id = cra.customer_receipt_id
         and lower(coalesce(cr.receipt_status, 'posted')) not in ('cancelled', 'draft', 'void')
        where ci.company_id = $1
          and lower(coalesce(ci.invoice_status, '')) not in ('cancelled', 'draft', 'void')
          ${idFilter}
        group by ci.id, ci.grand_total_invoice, ci.grand_total_base
      )
      update customer_invoices ci
      set
        paid_amount = least(alloc.grand, alloc.allocated),
        balance_due = greatest(alloc.grand - alloc.allocated, 0),
        invoice_status = case
          when alloc.grand - alloc.allocated <= 0.01 then 'paid'
          when lower(coalesce(ci.invoice_status, '')) = 'paid' then 'issued'
          else ci.invoice_status
        end,
        updated_at = now()
      from alloc
      where ci.id = alloc.id
    `,
    params
  );
  return r.rowCount || 0;
}

async function ensureFinanceBook(client, companyId, ledgerName) {
  const name = String(ledgerName || "").trim();
  const existing = await client.query(
    `
      select id from finance_books
      where company_id = $1 and lower(trim(book_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, name]
  );
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);

  const acctNo = (name.match(/(\d{6,})/) || [])[1] || null;
  const codeBase = name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 18).toUpperCase() || "BOOK";
  try {
    const ins = await client.query(
      `
        insert into finance_books (
          company_id, book_code, book_name, book_type, opening_balance,
          account_name, account_no, bank_name, is_active, updated_at
        )
        values ($1, $2, $3, $4, 0, $3, $5, $6, true, now())
        returning id
      `,
      [
        companyId,
        `TLY-${codeBase}`,
        name,
        bankBookType(name),
        acctNo,
        bankBookType(name) === "cash" ? null : name.split("-")[0].trim(),
      ]
    );
    return Number(ins.rows[0].id);
  } catch (err) {
    const again = await client.query(
      `
        select id from finance_books
        where company_id = $1 and lower(trim(book_name)) = lower(trim($2))
        limit 1
      `,
      [companyId, name]
    );
    if (again.rows[0]?.id) return Number(again.rows[0].id);
    throw err;
  }
}

async function resolveOrCreateVendor(client, companyId, partyName) {
  const name = String(partyName || "").trim();
  if (!name || isSkipParty(name)) return null;
  const existing = await client.query(
    `
      select id from vendors
      where company_id = $1 and lower(trim(company_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, name]
  );
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const slug = name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 12).toUpperCase() || "VND";
  const code = `TLY-${slug}-${Date.now().toString(36).slice(-4)}`;
  const ins = await client.query(
    `
      insert into vendors (company_id, vendor_code, company_name, is_active, created_at, updated_at)
      values ($1, $2, $3, true, now(), now())
      returning id
    `,
    [companyId, code, name]
  );
  return Number(ins.rows[0].id);
}

async function upsertAllocation(client, receiptId, invoiceId, amount) {
  const amt = money(amount);
  if (amt <= 0.009) return false;
  const existing = await client.query(
    `
      select id from customer_receipt_allocations
      where customer_receipt_id = $1 and customer_invoice_id = $2
      limit 1
    `,
    [receiptId, invoiceId]
  );
  if (existing.rows[0]?.id) {
    await client.query(
      `
        update customer_receipt_allocations
        set
          allocated_base = allocated_base + $2,
          allocated_invoice = allocated_invoice + $2,
          updated_at = now()
        where id = $1
      `,
      [existing.rows[0].id, amt]
    );
  } else {
    await client.query(
      `
        insert into customer_receipt_allocations (
          customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
        )
        values ($1, $2, $3, $3)
      `,
      [receiptId, invoiceId, amt]
    );
  }
  return true;
}

async function refreshReceiptTotals(client, receiptId) {
  await client.query(
    `
      update customer_receipts cr
      set
        allocated_amount_invoice = least(cr.receipt_amount_invoice, coalesce(x.allocated, 0)),
        allocated_amount_base = least(cr.receipt_amount_base, coalesce(x.allocated, 0)),
        unallocated_amount_invoice = greatest(cr.receipt_amount_invoice - coalesce(x.allocated, 0), 0),
        unallocated_amount_base = greatest(cr.receipt_amount_base - coalesce(x.allocated, 0), 0),
        updated_at = now()
      from (
        select coalesce(sum(allocated_invoice), 0) as allocated
        from customer_receipt_allocations
        where customer_receipt_id = $1
      ) x
      where cr.id = $1
    `,
    [receiptId]
  );
}

async function cancelNonTradeTallyReceipts(client, companyId) {
  const rows = await client.query(
    `
      select cr.id, c.customer_name, cr.unallocated_amount_invoice
      from customer_receipts cr
      join customers c on c.id = cr.customer_id
      where cr.company_id = $1
        and cr.receipt_source = 'tally_import'
        and lower(coalesce(cr.receipt_status, 'posted')) = 'posted'
        and cr.unallocated_amount_invoice > 0.01
    `,
    [companyId]
  );
  const stats = { cancelled: 0, amount: 0, reasons: {} };
  for (const row of rows.rows) {
    const name = String(row.customer_name || "").trim();
    let reason = null;
    if (isBankCashLedger(name) || /^icici bank\b/i.test(name)) reason = "bank_ledger_party";
    else if (isSkipParty(name)) reason = "skip_party";
    else if (/short\s*&?\s*excess|unsecured|loan|insurance|amazon pay|facebook india/i.test(name)) {
      reason = "non_trade_party";
    }
    if (!reason) continue;
    await client.query(`delete from customer_receipt_allocations where customer_receipt_id = $1`, [row.id]);
    await client.query(
      `
        update customer_receipts
        set
          receipt_status = 'cancelled',
          allocated_amount_base = 0,
          allocated_amount_invoice = 0,
          unallocated_amount_base = 0,
          unallocated_amount_invoice = 0,
          remarks = left(coalesce(remarks, '') || ' | cancelled: non-trade tally receipt (' || $2 || ')', 500),
          updated_at = now()
        where id = $1
      `,
      [row.id, reason]
    );
    stats.cancelled += 1;
    stats.amount = money(stats.amount + money(row.unallocated_amount_invoice));
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  }
  return stats;
}

async function allocateOnAccountFifo(client, companyId) {
  const receipts = await client.query(
    `
      select
        cr.id,
        cr.customer_id,
        cr.unallocated_amount_invoice,
        c.customer_name,
        c.gstin
      from customer_receipts cr
      join customers c on c.id = cr.customer_id
      where cr.company_id = $1
        and cr.receipt_source = 'tally_import'
        and lower(coalesce(cr.receipt_status, 'posted')) = 'posted'
        and cr.unallocated_amount_invoice > 0.01
      order by cr.receipt_date asc, cr.id asc
    `,
    [companyId]
  );
  const invoiceRes = await client.query(
    `
      select
        ci.id,
        ci.customer_id,
        ci.invoice_date,
        cu.customer_name,
        cu.gstin,
        greatest(
          coalesce(nullif(ci.grand_total_invoice, 0), ci.grand_total_base, 0)
          - coalesce((
              select sum(cra.allocated_invoice)
              from customer_receipt_allocations cra
              join customer_receipts cr on cr.id = cra.customer_receipt_id
              where cra.customer_invoice_id = ci.id
                and lower(coalesce(cr.receipt_status, 'posted')) not in ('cancelled', 'draft', 'void')
            ), 0),
          0
        ) as open_amt
      from customer_invoices ci
      join customers cu on cu.id = ci.customer_id
      where ci.company_id = $1
        and lower(coalesce(ci.invoice_status, '')) not in ('cancelled', 'draft', 'void')
      order by ci.invoice_date asc nulls last, ci.id asc
    `,
    [companyId]
  );
  const openById = new Map(
    invoiceRes.rows.map((row) => [Number(row.id), { ...row, open_amt: money(row.open_amt) }])
  );
  let allocatedReceipts = 0;
  let fuzzyMatched = 0;
  let unmatched = 0;
  let unmatchedAmount = 0;
  const touched = [];

  for (const rcpt of receipts.rows) {
    let remaining = money(rcpt.unallocated_amount_invoice);
    if (remaining <= 0.01) continue;
    const candidates = pickBestInvoiceMatches(
      rcpt.customer_name,
      rcpt.gstin,
      [...openById.values()].filter((inv) => money(inv.open_amt) > 0.01)
    );
    if (!candidates.length) {
      unmatched += 1;
      unmatchedAmount = money(unmatchedAmount + remaining);
      continue;
    }
    if (candidates.some((row) => row.method === "fuzzy" || row.method === "contain")) {
      fuzzyMatched += 1;
    }
    let used = false;
    for (const row of candidates) {
      const live = openById.get(Number(row.inv.id));
      const open = money(live?.open_amt);
      if (open <= 0.01 || remaining <= 0.01) continue;
      const apply = Math.min(open, remaining);
      await upsertAllocation(client, rcpt.id, live.id, apply);
      remaining = money(remaining - apply);
      live.open_amt = money(open - apply);
      touched.push(Number(live.id));
      used = true;
    }
    if (used) {
      allocatedReceipts += 1;
      await refreshReceiptTotals(client, rcpt.id);
    }
    if (remaining > 0.01) {
      unmatchedAmount = money(unmatchedAmount + remaining);
    }
  }
  return {
    allocatedReceipts,
    invoiceCount: new Set(touched).size,
    fuzzyMatched,
    unmatched,
    unmatchedAmount,
  };
}

function findBankEntries(raw) {
  return (raw.entries || []).filter((e) => isBankCashLedger(e.ledger_name) && money(e.amount) > 0);
}

async function importReceipts(client, companyId, vouchers, { batchId = null } = {}) {
  const stats = { created: 0, skipped: 0, failed: 0, linked_books: 0 };
  for (const raw of vouchers) {
    if (!isTallyReceiptVoucher(raw.voucher_type)) continue;
    if (!raw.party_name || isSkipParty(raw.party_name)) {
      stats.skipped += 1;
      continue;
    }
    try {
      const result = await createJoshReceiptFromTallyVoucher(client, {
        companyId,
        batchId,
        raw,
        userId: null,
      });
      if (result.created) stats.created += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.failed += 1;
      stats.last_error = err?.message || String(err);
    }
  }
  return stats;
}

async function importCreditNotesAsAllocations(client, companyId, vouchers) {
  const stats = { created: 0, skipped: 0 };
  for (const raw of vouchers) {
    if (!isCreditNote(raw.voucher_type)) continue;
    const amount = money(raw.amount);
    if (amount <= 0 || isSkipParty(raw.party_name)) {
      stats.skipped += 1;
      continue;
    }
    const dup = await client.query(
      `
        select id from customer_receipts
        where company_id = $1
          and receipt_source = 'tally_import'
          and tally_voucher_number = $2
          and tally_voucher_date = $3::date
        limit 1
      `,
      [companyId, raw.voucher_number, raw.date]
    );
    if (dup.rows[0]?.id) {
      stats.skipped += 1;
      continue;
    }
    const customerId = await resolveOrCreateCustomerForParty(client, companyId, raw.party_name);
    if (!customerId) {
      stats.skipped += 1;
      continue;
    }
    const currencyIdRes = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
    const currencyId = currencyIdRes.rows[0]?.id || 1;
    const numRes = await client.query(`select next_company_document_number($1, 'RCPT') as receipt_number`, [companyId]);
    await client.query(
      `
        insert into customer_receipts (
          receipt_number, company_id, customer_id, receipt_status, receipt_date,
          base_currency_id, receipt_currency_id,
          receipt_amount_base, receipt_amount_invoice,
          allocated_amount_base, allocated_amount_invoice,
          unallocated_amount_base, unallocated_amount_invoice,
          payment_mode, reference_no, remarks,
          receipt_source, tally_voucher_number, tally_voucher_type, tally_voucher_date,
          created_at, updated_at
        )
        values (
          $1, $2, $3, 'posted', $4::date,
          $5, $5,
          $6, $6,
          0, 0, $6, $6,
          'Credit Note', $7, $8,
          'tally_import', $7, $9, $4::date,
          now(), now()
        )
      `,
      [
        numRes.rows[0]?.receipt_number,
        companyId,
        customerId,
        raw.date,
        currencyId,
        amount,
        raw.voucher_number,
        raw.narration ? `Tally credit note: ${raw.narration}` : "Tally credit note (AR reduction, not cash)",
        raw.voucher_type,
      ]
    );
    stats.created += 1;
  }
  return stats;
}

async function importPurchaseBills(client, companyId, vouchers) {
  const stats = { created: 0, skipped: 0 };
  for (const raw of vouchers) {
    if (!isPurchaseVoucher(raw.voucher_type)) continue;
    const amount = money(raw.amount);
    if (amount <= 0 || isSkipParty(raw.party_name)) {
      stats.skipped += 1;
      continue;
    }
    const vendorId = await resolveOrCreateVendor(client, companyId, raw.party_name);
    if (!vendorId) {
      stats.skipped += 1;
      continue;
    }
    const existing = await client.query(
      `
        select id from vendor_bills
        where company_id = $1 and vendor_id = $2 and vendor_invoice_ref = $3
        limit 1
      `,
      [companyId, vendorId, raw.voucher_number]
    );
    if (existing.rows[0]?.id) {
      stats.skipped += 1;
      continue;
    }
    const tax = extractTaxFromLedgerEntries(raw.entries || []);
    const taxTotal = money(tax.taxTotal);
    const numRes = await client.query(`select next_company_document_number($1, 'BILL') as num`, [companyId]);
    await client.query(
      `
        insert into vendor_bills (
          company_id, bill_number, vendor_id, vendor_invoice_ref, bill_date,
          subtotal, tax_total, grand_total, paid_amount,
          match_status, payment_status, match_notes, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5::date,
          $6, $7, $8, 0,
          'matched_ok', 'unpaid', $9, now(), now()
        )
      `,
      [
        companyId,
        numRes.rows[0]?.num || `TLY-BILL-${raw.voucher_number}`,
        vendorId,
        raw.voucher_number,
        raw.date,
        money(amount - taxTotal),
        taxTotal,
        amount,
        SYNC_NOTE,
      ]
    );
    stats.created += 1;
  }
  return stats;
}

async function applyDebitNoteToVendorBills(client, companyId, vendorId, amount) {
  let remaining = money(amount);
  if (remaining <= 0.01) return 0;
  const bills = await client.query(
    `
      select id, greatest(grand_total - paid_amount, 0) as open_amt
      from vendor_bills
      where company_id = $1 and vendor_id = $2 and payment_status <> 'paid'
      order by bill_date asc nulls last, id asc
    `,
    [companyId, vendorId]
  );
  let settled = 0;
  for (const bill of bills.rows) {
    const open = money(bill.open_amt);
    if (open <= 0.01 || remaining <= 0.01) continue;
    const apply = Math.min(open, remaining);
    await client.query(
      `
        update vendor_bills
        set
          paid_amount = paid_amount + $2,
          payment_status = case
            when paid_amount + $2 >= grand_total - 0.01 then 'paid'
            else 'partially_paid'
          end,
          updated_at = now()
        where id = $1
      `,
      [bill.id, apply]
    );
    remaining = money(remaining - apply);
    settled += 1;
  }
  return settled;
}

async function importDebitNotesAsPurchaseReturns(client, companyId, vouchers) {
  const stats = { created: 0, skipped: 0, bills_settled: 0, amount: 0 };
  const currencyIdRes = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const currencyId = currencyIdRes.rows[0]?.id || 1;

  for (const raw of vouchers) {
    if (!isDebitNote(raw.voucher_type)) continue;
    const amount = money(raw.amount);
    if (amount <= 0 || isSkipParty(raw.party_name)) {
      stats.skipped += 1;
      continue;
    }

    const dnKey = `TLY-DN-${String(raw.voucher_number || "").trim() || "NA"}-${raw.date || "NA"}`;
    const dup = await client.query(
      `
        select id from purchase_returns
        where company_id = $1
          and (
            debit_note_number = $2
            or remarks like $3
          )
        limit 1
      `,
      [companyId, dnKey, `%${SYNC_NOTE}:debit_note:${raw.voucher_number}%`]
    );
    if (dup.rows[0]?.id) {
      stats.skipped += 1;
      continue;
    }

    const vendorId = await resolveOrCreateVendor(client, companyId, raw.party_name);
    if (!vendorId) {
      stats.skipped += 1;
      continue;
    }

    const tax = extractTaxFromLedgerEntries(raw.entries || []);
    const taxTotal = money(tax.taxTotal);
    const subtotal = money(Math.max(amount - taxTotal, 0));
    const expenseName =
      (raw.entries || []).find(
        (e) =>
          !e.is_debit &&
          !isApExcludedLedger(e.ledger_name) &&
          !isTallyGstLedger(e.ledger_name) &&
          decodePartyName(e.ledger_name).toLowerCase() !== decodePartyName(raw.party_name).toLowerCase()
      )?.ledger_name || "Tally debit note";

    const numRes = await client.query(
      `select next_company_document_number($1, 'PRET') as return_number`,
      [companyId]
    );

    let returnId = null;
    try {
      const ins = await client.query(
        `
          insert into purchase_returns (
            company_id, return_number, debit_note_number, vendor_id,
            return_status, return_date,
            base_currency_id, return_currency_id,
            subtotal_base, subtotal_invoice,
            tax_total_base, tax_total_invoice,
            grand_total_base, grand_total_invoice,
            remarks, created_at, updated_at
          )
          values (
            $1, $2, $3, $4,
            'posted', $5::date,
            $6, $6,
            $7, $7,
            $8, $8,
            $9, $9,
            $10, now(), now()
          )
          returning id
        `,
        [
          companyId,
          numRes.rows[0]?.return_number,
          dnKey,
          vendorId,
          raw.date,
          currencyId,
          subtotal,
          taxTotal,
          amount,
          `${SYNC_NOTE}:debit_note:${raw.voucher_number} | ${raw.narration || raw.voucher_type}`,
        ]
      );
      returnId = Number(ins.rows[0].id);
    } catch (err) {
      // Unique debit_note_number collision — treat as already imported
      if (String(err?.code) === "23505") {
        stats.skipped += 1;
        continue;
      }
      throw err;
    }

    const gstPct =
      subtotal > 0.01 ? Math.round((taxTotal / subtotal) * 10000) / 100 : 0;
    await client.query(
      `
        insert into purchase_return_lines (
          purchase_return_id, line_no, item_code, item_name, line_description,
          qty_return, unit_price_base, unit_price_invoice, gst_pct,
          line_total_base, line_total_invoice
        )
        values ($1, 1, $2, $3, $4, 1, $5, $5, $6, $5, $5)
      `,
      [
        returnId,
        "TLY-DN",
        decodePartyName(expenseName).slice(0, 200),
        `Tally Debit Note ${raw.voucher_number || ""}`.trim(),
        subtotal > 0.01 ? subtotal : amount,
        gstPct,
      ]
    );

    stats.bills_settled += await applyDebitNoteToVendorBills(client, companyId, vendorId, amount);
    stats.created += 1;
    stats.amount = money(stats.amount + amount);
  }
  return stats;
}

async function applyPaymentsFifoAndBank(client, companyId, vouchers) {
  const stats = { payments_created: 0, payments_skipped: 0, bills_settled: 0, expense_bank_entries: 0 };
  const currencyIdRes = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const currencyId = currencyIdRes.rows[0]?.id || 1;

  await client.query(
    `
      update vendor_bills
      set paid_amount = 0, payment_status = 'unpaid', updated_at = now()
      where company_id = $1 and match_notes = $2
    `,
    [companyId, SYNC_NOTE]
  );

  for (const raw of vouchers) {
    if (!isPaymentVoucher(raw.voucher_type)) continue;
    const amount = money(raw.amount);
    if (amount <= 0) {
      stats.payments_skipped += 1;
      continue;
    }
    try {
    const bank = findBankEntries(raw)[0];
    const vendorId = isSkipParty(raw.party_name)
      ? null
      : await resolveOrCreateVendor(client, companyId, raw.party_name);

    if (vendorId) {
      const dup = await client.query(
        `
          select id from vendor_payments
          where company_id = $1 and reference_no = $2 and payment_date = $3::date
          limit 1
        `,
        [companyId, raw.voucher_number, raw.date]
      );
      let paymentId = dup.rows[0]?.id ? Number(dup.rows[0].id) : null;
      if (!paymentId) {
        const numRes = await client.query(
          `select next_company_document_number($1, 'VPAY') as payment_number`,
          [companyId]
        );
        const ins = await client.query(
          `
            insert into vendor_payments (
              company_id, payment_number, vendor_id, payment_status, payment_date,
              payment_currency_id, finance_book_id, payment_amount, net_payment_amount,
              payment_mode, reference_no, bank_name, remarks, created_at, updated_at
            )
            values (
              $1, $2, $3, 'posted', $4::date,
              $5, null, $6, $6,
              $7, $8, $9, $10, now(), now()
            )
            returning id
          `,
          [
            companyId,
            numRes.rows[0]?.payment_number,
            vendorId,
            raw.date,
            currencyId,
            amount,
            bank ? bank.ledger_name : "Bank Transfer",
            raw.voucher_number,
            bank?.ledger_name || null,
            `${SYNC_NOTE}: ${raw.narration || raw.voucher_type}`,
          ]
        );
        paymentId = Number(ins.rows[0].id);
        stats.payments_created += 1;
      } else {
        stats.payments_skipped += 1;
      }

      let remaining = amount;
      const bills = await client.query(
        `
          select id, greatest(grand_total - paid_amount, 0) as open_amt
          from vendor_bills
          where company_id = $1 and vendor_id = $2 and payment_status <> 'paid'
          order by bill_date asc, id asc
        `,
        [companyId, vendorId]
      );
      for (const bill of bills.rows) {
        const open = money(bill.open_amt);
        if (open <= 0.01 || remaining <= 0.01) continue;
        const apply = Math.min(open, remaining);
        await client.query(
          `
            update vendor_bills
            set
              paid_amount = paid_amount + $2,
              payment_status = case
                when paid_amount + $2 >= grand_total - 0.01 then 'paid'
                else 'partially_paid'
              end,
              updated_at = now()
            where id = $1
          `,
          [bill.id, apply]
        );
        remaining = money(remaining - apply);
        stats.bills_settled += 1;
      }
    } else {
      stats.payments_skipped += 1;
    }
    } catch (err) {
      stats.payments_skipped += 1;
      stats.last_error = err?.message || String(err);
    }
  }
  return stats;
}

async function syncBankLedgersFromVouchers(client, companyId, vouchers) {
  await client.query(
    `
      delete from finance_book_entries
      where company_id = $1
        and (remarks = $2 or entry_number like 'TLY-SYNC-%')
    `,
    [companyId, SYNC_NOTE]
  );
  await client.query(
    `
      update customer_receipts
      set finance_book_id = null, updated_at = now()
      where company_id = $1 and receipt_source = 'tally_import'
    `,
    [companyId]
  );
  await client.query(
    `
      update vendor_payments
      set finance_book_id = null, updated_at = now()
      where company_id = $1 and remarks like $2
    `,
    [companyId, `${SYNC_NOTE}%`]
  );

  const stats = { lines: 0, receipts: 0, payments: 0, by_book: {} };
  let seq = 0;
  for (const raw of vouchers) {
    for (const entry of findBankEntries(raw)) {
      seq += 1;
      const bookId = await ensureFinanceBook(client, companyId, entry.ledger_name);
      const entryType = bankLineIsDebit(entry) ? "receipt" : "payment";
      const amt = bankLineAmount(entry);
      const entryNumber = `TLY-SYNC-BANK-${seq}-${raw.voucher_number || "NA"}`;
      await client.query(
        `
          insert into finance_book_entries (
            company_id, finance_book_id, entry_number, entry_status, entry_date,
            entry_type, amount, counterparty_name, reference_no, remarks, updated_at
          )
          values ($1, $2, $3, 'posted', $4::date, $5, $6, $7, $8, $9, now())
        `,
        [
          companyId,
          bookId,
          entryNumber,
          raw.date,
          entryType,
          amt,
          raw.party_name || raw.voucher_type,
          raw.voucher_number,
          SYNC_NOTE,
        ]
      );
      stats.lines += 1;
      if (entryType === "receipt") stats.receipts += amt;
      else stats.payments += amt;
      stats.by_book[entry.ledger_name] = money((stats.by_book[entry.ledger_name] || 0) + (entryType === "receipt" ? amt : -amt));
    }
  }
  stats.receipts = money(stats.receipts);
  stats.payments = money(stats.payments);
  stats.net = money(stats.receipts - stats.payments);
  return stats;
}

async function rebuildCashGl(client, companyId) {
  const bankId = await getOrCreateGlAccount(
    client,
    companyId,
    "1400",
    "Bank & Cash Accounts",
    "asset",
    "debit"
  );
  const clearingId = await getOrCreateGlAccount(
    client,
    companyId,
    "3100",
    "Retained Earnings",
    "equity",
    "credit"
  );
  await client.query(
    `delete from general_ledger_entries where company_id = $1 and source_event = $2`,
    [companyId, SOURCE_EVENT]
  );

  const books = await client.query(
    `
      with manual as (
        select
          e.finance_book_id,
          coalesce(sum(case when e.entry_status = 'posted' and e.entry_type = 'receipt' then e.amount else 0 end), 0) as receipts,
          coalesce(sum(case when e.entry_status = 'posted' and e.entry_type = 'payment' then e.amount else 0 end), 0) as payments
        from finance_book_entries e
        where e.company_id = $1
        group by e.finance_book_id
      )
      select
        fb.id,
        fb.book_name,
        (fb.opening_balance + coalesce(m.receipts, 0) - coalesce(m.payments, 0)) as closing
      from finance_books fb
      left join manual m on m.finance_book_id = fb.id
      where fb.company_id = $1
    `,
    [companyId]
  );

  let posted = 0;
  let net = 0;
  for (const row of books.rows) {
    const closing = money(row.closing);
    net += closing;
    if (Math.abs(closing) < 0.01) continue;
    const entryNumber = `TLY-SYNC-GL-${row.id}`;
    if (closing > 0) {
      await client.query(
        `
          insert into general_ledger_entries (
            company_id, entry_number, account_id, entry_date, source_event,
            ref_type, ref_id, debit, credit, narration
          )
          values
            ($1, $2, $3, current_date, $4, 'finance_books', $5, $6, 0, $7),
            ($1, $8, $9, current_date, $4, 'finance_books', $5, 0, $6, $7)
        `,
        [
          companyId,
          `${entryNumber}-DR`,
          bankId,
          SOURCE_EVENT,
          row.id,
          closing,
          `Tally bank book closing: ${row.book_name}`,
          `${entryNumber}-CR`,
          clearingId,
        ]
      );
    } else {
      const amt = Math.abs(closing);
      await client.query(
        `
          insert into general_ledger_entries (
            company_id, entry_number, account_id, entry_date, source_event,
            ref_type, ref_id, debit, credit, narration
          )
          values
            ($1, $2, $3, current_date, $4, 'finance_books', $5, $6, 0, $7),
            ($1, $8, $9, current_date, $4, 'finance_books', $5, 0, $6, $7)
        `,
        [
          companyId,
          `${entryNumber}-DR`,
          clearingId,
          SOURCE_EVENT,
          row.id,
          amt,
          `Tally bank book closing: ${row.book_name}`,
          `${entryNumber}-CR`,
          bankId,
        ]
      );
    }
    posted += 1;
  }
  return { books: books.rows.length, gl_legs: posted, net_cash: money(net) };
}

async function rebuildGstGl(client, companyId, vouchers) {
  const pos = computeTallyGstPosition(vouchers);
  const outputId = await getOrCreateGlAccount(
    client,
    companyId,
    "2200",
    "GST Output Tax Liability",
    "liability",
    "credit"
  );
  const itcId = await getOrCreateGlAccount(
    client,
    companyId,
    "1300",
    "GST Input Tax Credit (ITC Receivable)",
    "asset",
    "debit"
  );
  const paidId = await getOrCreateGlAccount(
    client,
    companyId,
    "2210",
    "GST Paid (Challans)",
    "liability",
    "debit"
  );
  const clearingId = await getOrCreateGlAccount(
    client,
    companyId,
    "3100",
    "Retained Earnings",
    "equity",
    "credit"
  );
  await client.query(
    `delete from general_ledger_entries where company_id = $1 and source_event = $2`,
    [companyId, GST_SOURCE_EVENT]
  );

  const entryDate = pos.as_of || new Date().toISOString().slice(0, 10);
  async function postPair(entryNumber, debitId, creditId, amount, narration) {
    const amt = money(amount);
    if (amt <= 0.01) return false;
    await client.query(
      `
        insert into general_ledger_entries (
          company_id, entry_number, account_id, entry_date, source_event,
          ref_type, ref_id, debit, credit, narration
        )
        values
          ($1, $2, $3, $4::date, $5, 'tally_gst', 0, $6, 0, $7),
          ($1, $8, $9, $4::date, $5, 'tally_gst', 0, 0, $6, $7)
      `,
      [
        companyId,
        `${entryNumber}-DR`,
        debitId,
        entryDate,
        GST_SOURCE_EVENT,
        amt,
        narration,
        `${entryNumber}-CR`,
        creditId,
      ]
    );
    return true;
  }

  let posted = 0;
  if (await postPair("TLY-GST-OUT", clearingId, outputId, pos.output, "Tally output GST ledger closing")) {
    posted += 1;
  }
  if (await postPair("TLY-GST-ITC", itcId, clearingId, pos.input, "Tally input GST / ITC ledger closing")) {
    posted += 1;
  }
  const gstPaid = money(Math.max(0, -pos.cash_gst));
  if (await postPair("TLY-GST-PAID", paidId, clearingId, gstPaid, "Tally GST challan / Cash-GST ledger closing")) {
    posted += 1;
  }

  return {
    ...pos,
    gst_paid: gstPaid,
    gl_legs: posted,
    net_gst: pos.net,
  };
}

async function findVendorIdForApParty(client, companyId, partyName) {
  const name = decodePartyName(partyName);
  if (!name || isApExcludedLedger(name)) return null;
  const exact = await client.query(
    `
      select id from vendors
      where company_id = $1 and lower(trim(company_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, name]
  );
  if (exact.rows[0]?.id) return Number(exact.rows[0].id);

  const vendors = await client.query(
    `
      select id, company_name from vendors
      where company_id = $1 and coalesce(is_active, true) = true
    `,
    [companyId]
  );
  let best = null;
  for (const row of vendors.rows) {
    const m = partyMatchScore(name, row.company_name);
    if (m.score < FIFO_MATCH_MIN) continue;
    if (!best || m.score > best.score) best = { id: Number(row.id), score: m.score };
  }
  if (best) return best.id;
  return resolveOrCreateVendor(client, companyId, name);
}

async function reconcileVendorBillsToTallyAp(client, companyId, vouchers) {
  const pos = computeTallyApPosition(vouchers);
  const stats = {
    net: pos.net,
    party_count: pos.party_count,
    as_of: pos.as_of,
    vendors_adjusted: 0,
    bills_closed: 0,
    topups_created: 0,
    extras_closed: 0,
  };

  await client.query(
    `
      delete from vendor_bills
      where company_id = $1 and match_notes = $2
    `,
    [companyId, AP_CLOSE_NOTE]
  );

  const matchedVendorIds = new Set();

  for (const [partyName, targetOpen] of Object.entries(pos.by_party)) {
    const vendorId = await findVendorIdForApParty(client, companyId, partyName);
    if (!vendorId) continue;
    matchedVendorIds.add(vendorId);

    const bills = await client.query(
      `
        select id, grand_total, paid_amount,
               greatest(grand_total - paid_amount, 0) as open_amt
        from vendor_bills
        where company_id = $1 and vendor_id = $2
        order by bill_date asc nulls last, id asc
      `,
      [companyId, vendorId]
    );
    let currentOpen = money(
      bills.rows.reduce((sum, row) => sum + money(row.open_amt), 0)
    );
    const target = money(targetOpen);
    if (Math.abs(currentOpen - target) <= 0.01) continue;

    stats.vendors_adjusted += 1;

    if (currentOpen > target) {
      let excess = money(currentOpen - target);
      for (const bill of bills.rows) {
        if (excess <= 0.01) break;
        const open = money(bill.open_amt);
        if (open <= 0.01) continue;
        const apply = Math.min(open, excess);
        const newPaid = money(money(bill.paid_amount) + apply);
        await client.query(
          `
            update vendor_bills
            set
              paid_amount = $2,
              payment_status = case
                when $2 >= grand_total - 0.01 then 'paid'
                when $2 > 0.01 then 'partially_paid'
                else 'unpaid'
              end,
              updated_at = now()
            where id = $1
          `,
          [bill.id, newPaid]
        );
        excess = money(excess - apply);
        stats.bills_closed += 1;
      }
    } else {
      const gap = money(target - currentOpen);
      const numRes = await client.query(
        `select next_company_document_number($1, 'BILL') as num`,
        [companyId]
      );
      await client.query(
        `
          insert into vendor_bills (
            company_id, bill_number, vendor_id, vendor_invoice_ref, bill_date,
            subtotal, tax_total, grand_total, paid_amount,
            match_status, payment_status, match_notes, created_at, updated_at
          )
          values (
            $1, $2, $3, $4, coalesce($5::date, current_date),
            $6, 0, $6, 0,
            'matched_ok', 'unpaid', $7, now(), now()
          )
        `,
        [
          companyId,
          numRes.rows[0]?.num || `TLY-AP-${vendorId}`,
          vendorId,
          `TLY-AP-OPEN-${vendorId}`,
          pos.as_of,
          gap,
          AP_CLOSE_NOTE,
        ]
      );
      stats.topups_created += 1;
    }
  }

  const extras = await client.query(
    `
      select vendor_id, sum(greatest(grand_total - paid_amount, 0)) as open_amt
      from vendor_bills
      where company_id = $1
        and payment_status <> 'paid'
      group by vendor_id
      having sum(greatest(grand_total - paid_amount, 0)) > 0.01
    `,
    [companyId]
  );
  for (const row of extras.rows) {
    const vendorId = Number(row.vendor_id);
    if (matchedVendorIds.has(vendorId)) continue;
    await client.query(
      `
        update vendor_bills
        set
          paid_amount = grand_total,
          payment_status = 'paid',
          updated_at = now()
        where company_id = $1
          and vendor_id = $2
          and payment_status <> 'paid'
      `,
      [companyId, vendorId]
    );
    stats.extras_closed += 1;
  }

  const check = await client.query(
    `
      select coalesce(sum(greatest(grand_total - paid_amount, 0)), 0) as open_ap,
             count(*) filter (where payment_status in ('unpaid', 'partially_paid')) as open_bills
      from vendor_bills
      where company_id = $1
    `,
    [companyId]
  );
  stats.josh_open_ap = money(check.rows[0]?.open_ap);
  stats.open_bills = Number(check.rows[0]?.open_bills || 0);
  return stats;
}

async function rebuildApGl(client, companyId, vouchers) {
  const pos = computeTallyApPosition(vouchers);
  const apId = await getOrCreateGlAccount(
    client,
    companyId,
    "2100",
    "Accounts Payable (Trade Creditors)",
    "liability",
    "credit"
  );
  const clearingId = await getOrCreateGlAccount(
    client,
    companyId,
    "3100",
    "Retained Earnings",
    "equity",
    "credit"
  );
  await client.query(
    `delete from general_ledger_entries where company_id = $1 and source_event = $2`,
    [companyId, AP_SOURCE_EVENT]
  );

  const entryDate = pos.as_of || new Date().toISOString().slice(0, 10);
  const amt = money(pos.net);
  let posted = 0;
  if (amt > 0.01) {
    await client.query(
      `
        insert into general_ledger_entries (
          company_id, entry_number, account_id, entry_date, source_event,
          ref_type, ref_id, debit, credit, narration
        )
        values
          ($1, $2, $3, $4::date, $5, 'tally_ap', 0, $6, 0, $7),
          ($1, $8, $9, $4::date, $5, 'tally_ap', 0, 0, $6, $7)
      `,
      [
        companyId,
        "TLY-AP-NET-DR",
        clearingId,
        entryDate,
        AP_SOURCE_EVENT,
        amt,
        `Tally creditor ledger closing (${pos.party_count} parties)`,
        "TLY-AP-NET-CR",
        apId,
      ]
    );
    posted = 1;
  }

  return {
    net: pos.net,
    party_count: pos.party_count,
    as_of: pos.as_of,
    gl_legs: posted,
    top_parties: Object.entries(pos.by_party)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, amount]) => ({ name, amount })),
  };
}

function classifyTallyJournal(raw) {
  const names = (raw.entries || [])
    .map((e) => decodePartyName(e.ledger_name).toLowerCase())
    .join(" | ");
  const narr = decodePartyName(raw.narration).toLowerCase();
  const blob = `${names} ${narr}`;
  if (/tds\b|194[a-z]|194c|194[ij]|194q|194h|tds payable/.test(blob)) return "tds";
  if (/salary|payroll|\bpf\b|provident|\besi\b|gratuity|wages/.test(blob)) return "salary";
  if (
    /input (cgst|sgst|igst)|output (cgst|sgst|igst)|cash - (cgst|sgst|igst)|\brcm\b/.test(blob)
  ) {
    return "gst";
  }
  if (/provision|depreciation|written off|write off|bad debt/.test(blob)) return "provision";
  if (/absstem technologies|intercompany|inter-company|inter company/.test(blob)) return "intercompany";
  if (/round off|rounding/.test(blob)) return "round_off";
  if (/audit entry|audit fee/.test(blob) || typeKey(raw.voucher_type).includes("audit")) return "audit";
  if (/interest|loan|\bod\b|cc limit|bank charge|bank charges|finance charge/.test(blob)) return "finance";
  if (/travelling|travel|imprest|rent|advertis|campaign|expense|conveyance|petrol|diesel/.test(blob)) {
    return "expense";
  }
  if (typeKey(raw.voucher_type) === "contra") return "contra";
  return "other";
}

function inferGlAccountType(ledgerName) {
  const n = decodePartyName(ledgerName).toLowerCase();
  if (isBankCashLedger(ledgerName) || /\bimprest\b|\bcash\b|\bbank\b/.test(n)) return "asset";
  if (/input (cgst|sgst|igst)|receivable|debtor|advance to/.test(n)) return "asset";
  if (
    /payable|provision|output (cgst|sgst|igst)|tds payable|creditor|loan|gst payable/.test(n)
  ) {
    return "liability";
  }
  if (/capital|drawings|retained|equity/.test(n)) return "equity";
  if (/sales|income|interest received|discount received/.test(n)) return "income";
  if (/purchase|salary|rent|expense|freight|travelling|advertis|commission|charges|fees|depreciation/.test(n)) {
    return "expense";
  }
  return "expense";
}

function tallyGlAccountCode(ledgerName) {
  const name = decodePartyName(ledgerName);
  const slug = name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 14).toUpperCase() || "LED";
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  return `TLY-${slug}-${String(Math.abs(hash)).padStart(5, "0")}`.slice(0, 40);
}

async function ensureGlDeskAccount(client, companyId, ledgerName, cache) {
  const name = decodePartyName(ledgerName).slice(0, 200);
  if (!name) return null;
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const existing = await client.query(
    `
      select id from gl_accounts
      where company_id = $1 and lower(trim(account_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, name]
  );
  if (existing.rows[0]?.id) {
    const id = Number(existing.rows[0].id);
    cache.set(key, id);
    return id;
  }

  const accountType = inferGlAccountType(name);
  const normalBalance = accountType === "asset" || accountType === "expense" ? "debit" : "credit";
  const code = tallyGlAccountCode(name);
  try {
    const ins = await client.query(
      `
        insert into gl_accounts (
          company_id, account_code, account_name, account_type, normal_balance, is_active
        )
        values ($1, $2, $3, $4, $5, true)
        returning id
      `,
      [companyId, code, name, accountType, normalBalance]
    );
    const id = Number(ins.rows[0].id);
    cache.set(key, id);
    return id;
  } catch (_err) {
    const again = await client.query(
      `
        select id from gl_accounts
        where company_id = $1
          and (lower(trim(account_name)) = lower(trim($2)) or account_code = $3)
        limit 1
      `,
      [companyId, name, code]
    );
    if (again.rows[0]?.id) {
      const id = Number(again.rows[0].id);
      cache.set(key, id);
      return id;
    }
    throw _err;
  }
}

function tallyJournalNo(raw, seq = 1) {
  const date = raw.date || "nodate";
  const num = String(raw.voucher_number || "NA")
    .replace(/\s+/g, "")
    .slice(0, 40);
  const amt = String(money(raw.amount)).replace(/\./g, "p");
  return `TLY-JV-${date}-${num}-${amt}-S${seq}`.slice(0, 100);
}

async function importTallyJournalsToGlDesk(client, companyId, vouchers) {
  const stats = {
    created: 0,
    skipped: 0,
    lines: 0,
    accounts_created: 0,
    by_category: {},
    amount: 0,
  };

  // Replace prior Tally journal import (idempotent full rebuild for this source)
  await client.query(
    `
      delete from gl_journals
      where company_id = $1 and journal_no like 'TLY-JV-%'
    `,
    [companyId]
  );

  const accountCache = new Map();
  const beforeAccounts = await client.query(
    `select count(*)::int as n from gl_accounts where company_id = $1 and account_code like 'TLY-%'`,
    [companyId]
  );
  const accountsBefore = Number(beforeAccounts.rows[0]?.n || 0);
  let seq = 0;

  for (const raw of vouchers) {
    if (!isContraOrJournal(raw.voucher_type)) continue;

    const entries = (raw.entries || []).filter((e) => money(e.amount) > 0 && decodePartyName(e.ledger_name));
    if (entries.length < 2) {
      stats.skipped += 1;
      continue;
    }

    let debitTotal = 0;
    let creditTotal = 0;
    const legs = [];
    for (const entry of entries) {
      const amt = money(entry.amount);
      if (entry.is_debit) debitTotal = money(debitTotal + amt);
      else creditTotal = money(creditTotal + amt);
      legs.push(entry);
    }
    if (debitTotal <= 0.01 || creditTotal <= 0.01) {
      stats.skipped += 1;
      continue;
    }
    // Allow 1 rupee imbalance from Tally rounding
    if (Math.abs(debitTotal - creditTotal) > 1.01) {
      stats.skipped += 1;
      continue;
    }

    const category = classifyTallyJournal(raw);
    seq += 1;
    const journalNo = tallyJournalNo(raw, seq);
    const narration = [
      `${SYNC_NOTE}:${category}`,
      raw.voucher_type,
      raw.voucher_number,
      decodePartyName(raw.narration),
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 500);

    const hdr = await client.query(
      `
        insert into gl_journals (
          company_id, journal_no, journal_date, journal_status, narration, posted_at, updated_at
        )
        values ($1, $2, $3::date, 'posted', $4, now(), now())
        returning id
      `,
      [companyId, journalNo, raw.date, narration]
    );
    const journalId = Number(hdr.rows[0].id);
    let lineNo = 0;
    for (const entry of legs) {
      const accountId = await ensureGlDeskAccount(client, companyId, entry.ledger_name, accountCache);
      if (!accountId) continue;
      lineNo += 1;
      const amt = money(entry.amount);
      await client.query(
        `
          insert into gl_journal_lines (
            journal_id, line_no, account_id, line_remarks, debit, credit
          )
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          journalId,
          lineNo,
          accountId,
          decodePartyName(entry.ledger_name).slice(0, 200),
          entry.is_debit ? amt : 0,
          entry.is_debit ? 0 : amt,
        ]
      );
      stats.lines += 1;
    }
    if (lineNo < 2) {
      await client.query(`delete from gl_journals where id = $1`, [journalId]);
      stats.skipped += 1;
      continue;
    }

    stats.created += 1;
    stats.amount = money(stats.amount + money(raw.amount));
    const bucket = stats.by_category[category] || { count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount = money(bucket.amount + money(raw.amount));
    stats.by_category[category] = bucket;
  }

  const afterAccounts = await client.query(
    `select count(*)::int as n from gl_accounts where company_id = $1 and account_code like 'TLY-%'`,
    [companyId]
  );
  stats.accounts_created = Math.max(0, Number(afterAccounts.rows[0]?.n || 0) - accountsBefore);
  stats.accounts_total_tally = Number(afterAccounts.rows[0]?.n || 0);
  return stats;
}

async function runTallyLedgerSync(client, { companyIdOrCode, xmlBuffer, fileName, apply = false }) {
  const company = await resolveCompany(client, companyIdOrCode);
  if (!company?.id) throw new Error(`Company not found: ${companyIdOrCode}`);
  const parsed = parseTallyData(xmlBuffer, fileName);
  const vouchers = parsed.vouchers || [];
  const summary = {
    company: company.company_code || company.display_name,
    company_id: company.id,
    xml_company: parsed.tallyCompanyName,
    voucher_count: vouchers.length,
    apply,
    receipts: { created: 0 },
    credit_notes: { created: 0 },
    purchases: { created: 0 },
    payments: {},
    journals: {},
    bank_ledgers: {},
    fifo: {},
    non_trade_receipts: {},
    invoices_updated: 0,
    cash_gl: {},
    gst: {},
    debit_notes: {},
    journals: {},
    ap: {},
  };

  if (!apply) {
    summary.preview = {
      receipts: vouchers.filter((v) => isTallyReceiptVoucher(v.voucher_type)).length,
      payments: vouchers.filter((v) => isPaymentVoucher(v.voucher_type)).length,
      purchases: vouchers.filter((v) => isPurchaseVoucher(v.voucher_type)).length,
      credit_notes: vouchers.filter((v) => isCreditNote(v.voucher_type)).length,
      debit_notes: vouchers.filter((v) => isDebitNote(v.voucher_type)).length,
      journals: vouchers.filter((v) => isContraOrJournal(v.voucher_type)).length,
    };
    return summary;
  }

  summary.receipts = await importReceipts(client, company.id, vouchers);
  summary.credit_notes = await importCreditNotesAsAllocations(client, company.id, vouchers);
  summary.non_trade_receipts = await cancelNonTradeTallyReceipts(client, company.id);
  await syncInvoicePaidAmounts(client, company.id);
  summary.fifo = await allocateOnAccountFifo(client, company.id);
  summary.invoices_updated = await syncInvoicePaidAmounts(client, company.id);
  summary.purchases = await importPurchaseBills(client, company.id, vouchers);
  summary.payments = await applyPaymentsFifoAndBank(client, company.id, vouchers);
  summary.debit_notes = await importDebitNotesAsPurchaseReturns(client, company.id, vouchers);
  summary.journals = await importTallyJournalsToGlDesk(client, company.id, vouchers);
  summary.ap = await reconcileVendorBillsToTallyAp(client, company.id, vouchers);
  summary.bank_ledgers = await syncBankLedgersFromVouchers(client, company.id, vouchers);
  summary.cash_gl = await rebuildCashGl(client, company.id);
  summary.gst = await rebuildGstGl(client, company.id, vouchers);
  summary.ap_gl = await rebuildApGl(client, company.id, vouchers);
  return summary;
}

module.exports = {
  runTallyLedgerSync,
  parseTallyData,
  isBankCashLedger,
  partyCoreKey,
  partyMatchScore,
  matchReceiptToInvoiceParty,
  computeTallyGstPosition,
  computeTallyApPosition,
  SYNC_NOTE,
  GST_SOURCE_EVENT,
  AP_SOURCE_EVENT,
};
