/**
 * Process QuotationReport_*.xlsx:
 *  1) Archive test/dummy rows
 *  2) Auto-close open/blank/Ongoing quotes older than the cutoff → Closed - No Feedback
 *  3) Write QuotationReport_Clean_AutoClosed.xlsx (+ archive workbook)
 *  4) Optionally --apply: stage cleaned rows + sync matching quote_headers for analytics
 *  5) Parse legacy Group packages into quote_lines (catalog-mapped when possible)
 *
 * Pair with process_lead_entry_report_hygiene.js (or process_legacy_hygiene_pipeline.js)
 * so LeadNo bridges preserve lead → quote → order conversion tracking.
 *
 * Usage:
 *   node scripts/process_quotation_report_hygiene.js --file=../QuotationReport_07-Sep-2026.xlsx
 *   node scripts/process_quotation_report_hygiene.js --file=... --apply
 *   node scripts/process_legacy_hygiene_pipeline.js --apply --company-id=2
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { parseLegacyGroups, indexCatalog } = require("../utils/parseLegacyGroups");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_CUTOFF = "2025-09-07";
const AUTO_CLOSE_STATUS = "Closed - No Feedback";
const AUTO_CLOSE_REMARK =
  "Auto-closed by QuotationReport hygiene ingest on 2026-09-07: quotation date older than 1 year with blank/Ongoing/open status and no customer feedback.";

const OPEN_STATUSES = new Set(["", "ongoing"]);

const WON_STATUSES = new Set([
  "converted to order",
  "converted",
  "closed in our favour",
]);

const LOST_STATUS_MAP = {
  "lost order": { code: "lost_competitor", label: "Lost Order" },
  "loose order": { code: "lost_competitor", label: "Loose order" },
  closed: { code: "other", label: "Closed" },
  "closed - project shelved": { code: "project_shelved", label: "Closed - Project Shelved" },
  "another quote": { code: "another_quote", label: "Another Quote" },
  "closed - no feedback": { code: "no_feedback", label: AUTO_CLOSE_STATUS },
};

function parseArgs(argv) {
  const out = {
    file: null,
    outDir: null,
    cutoff: DEFAULT_CUTOFF,
    apply: false,
    companyId: null,
    batch: `quotation_hygiene_${new Date().toISOString().slice(0, 10)}`,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    else if (token.startsWith("--file=")) out.file = path.resolve(token.slice(7));
    else if (token === "--file" && argv[i + 1]) {
      out.file = path.resolve(argv[++i]);
    } else if (token.startsWith("--out=")) out.outDir = path.resolve(token.slice(6));
    else if (token === "--out" && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
    else if (token.startsWith("--cutoff=")) out.cutoff = token.slice(9);
    else if (token === "--cutoff" && argv[i + 1]) out.cutoff = argv[++i];
    else if (token.startsWith("--batch=")) out.batch = token.slice(8).trim() || out.batch;
    else if (token === "--batch" && argv[i + 1]) out.batch = argv[++i].trim() || out.batch;
    else if (token.startsWith("--company-id=")) out.companyId = Number(token.slice(13));
    else if (token === "--company-id" && argv[i + 1]) out.companyId = Number(argv[++i]);
  }
  return out;
}

function parseLegacyDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }
  const raw = String(value || "").trim();
  if (!raw || raw === "01-Jan-1900") return null;
  const monthMap = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const datePart = raw.split(/\s+/)[0];
  const dm = datePart.split("-");
  if (dm.length !== 3) return null;
  const day = Number(dm[0]);
  const mon = monthMap[String(dm[1] || "").slice(0, 3).toUpperCase()];
  let year = Number(dm[2]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(day) || !Number.isFinite(mon) || !Number.isFinite(year)) return null;
  const dt = new Date(Date.UTC(year, mon, day));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatLegacyDate(dt) {
  if (!dt) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(dt.getUTCDate()).padStart(2, "0")}-${months[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}

function parseDisplayWithCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return { name: null, code: null, raw: "" };
  const match = raw.match(/^(.*?)(?:\s*:\s*([A-Z]\d+))?$/i);
  return {
    name: String(match?.[1] || raw).trim() || null,
    code: String(match?.[2] || "").trim() || null,
    raw,
  };
}

function parseLegacyActor(value) {
  const raw = String(value || "").trim();
  if (!raw) return { code: null, name: null, raw: "" };
  const idx = raw.indexOf(":");
  if (idx >= 0) {
    return {
      code: raw.slice(0, idx).trim().replace(/\s+/g, "") || null,
      name: raw.slice(idx + 1).trim() || null,
      raw,
    };
  }
  return { code: null, name: raw, raw };
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "").replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isTestRow(row) {
  const customer = String(row.Customer || "");
  const quoteNo = String(row.QuotationNo || "");
  const remarks = `${row.QuotationRemarks || ""} ${row.FinalRemarks || ""}`;
  if (/\bTEST\s+COMPANY\b/i.test(customer)) return true;
  if (/:\s*C12114\b/i.test(customer)) return true;
  if (/\bTEST\b/i.test(quoteNo)) return true;
  if (/\b(DUMMY|SAMPLE)\s+(QUOTE|ORDER|CUSTOMER|COMPANY)\b/i.test(customer)) return true;
  if (/\b(TEST|DUMMY)\s+(DATA|RECORD|QUOTE)\b/i.test(remarks)) return true;
  return false;
}

function isOpenStatus(statusRaw) {
  return OPEN_STATUSES.has(String(statusRaw || "").trim().toLowerCase());
}

function mapJoshStatus(statusRaw) {
  const key = String(statusRaw || "").trim().toLowerCase();
  if (WON_STATUSES.has(key)) return { quoteStatus: "converted", reasonCode: null };
  if (key === "closed - no feedback" || LOST_STATUS_MAP[key]) {
    const mapped = LOST_STATUS_MAP[key] || LOST_STATUS_MAP["closed - no feedback"];
    return { quoteStatus: "closed", reasonCode: mapped.code };
  }
  if (isOpenStatus(statusRaw)) return { quoteStatus: "issued", reasonCode: null };
  return { quoteStatus: "closed", reasonCode: "other" };
}

function writeWorkbook(filePath, rows, sheetName = "Table") {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filePath);
}

function processWorkbook(filePath, cutoffDate) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const archived = [];
  const cleaned = [];
  const summary = {
    total_rows: rawRows.length,
    test_archived: 0,
    auto_closed: 0,
    open_kept: 0,
    won: 0,
    lost_or_closed: 0,
    by_output_status: {},
  };

  for (const raw of rawRows) {
    const quotationDate = parseLegacyDate(raw.QuotationDate);
    const customer = parseDisplayWithCode(raw.Customer);
    const salesperson = parseLegacyActor(raw.SalesPerson);
    const base = {
      ...raw,
      QuotationNo: String(raw.QuotationNo || "").trim(),
      LeadNo: String(raw.LeadNo || "").trim(),
      QuotationDate: quotationDate ? formatLegacyDate(quotationDate) : String(raw.QuotationDate || "").trim(),
      Status: String(raw.Status || "").trim(),
      FinalRemarks: String(raw.FinalRemarks || "").trim(),
      QuotationRemarks: String(raw.QuotationRemarks || "").trim(),
      _quotationDate: quotationDate,
      _customerName: customer.name,
      _customerCode: customer.code,
      _salespersonCode: salesperson.code,
      _salespersonName: salesperson.name,
    };

    if (isTestRow(base)) {
      archived.push({
        ...stripInternal(base),
        HygieneAction: "ARCHIVED_TEST",
        HygieneReason: "Test/dummy marker (TEST COMPANY / C12114 / TEST quote marker)",
      });
      summary.test_archived += 1;
      continue;
    }

    let status = base.Status;
    let finalRemarks = base.FinalRemarks;
    let hygieneAction = "KEEP";

    if (isOpenStatus(status) && quotationDate && quotationDate < cutoffDate) {
      status = AUTO_CLOSE_STATUS;
      const audit = AUTO_CLOSE_REMARK;
      finalRemarks = finalRemarks ? `${finalRemarks} | ${audit}` : audit;
      hygieneAction = "AUTO_CLOSED_NO_FEEDBACK";
      summary.auto_closed += 1;
    } else if (isOpenStatus(status)) {
      summary.open_kept += 1;
    }

    const mapped = mapJoshStatus(status);
    if (mapped.quoteStatus === "converted") summary.won += 1;
    else if (mapped.quoteStatus === "closed") summary.lost_or_closed += 1;

    summary.by_output_status[status || "(blank)"] = (summary.by_output_status[status || "(blank)"] || 0) + 1;

    cleaned.push({
      ...stripInternal(base),
      Status: status,
      FinalRemarks: finalRemarks,
      HygieneAction: hygieneAction,
      JoshQuoteStatus: mapped.quoteStatus,
      JoshClosureReasonCode: mapped.reasonCode || "",
    });
  }

  return { archived, cleaned, summary };
}

function stripInternal(row) {
  const out = { ...row };
  delete out._quotationDate;
  delete out._customerName;
  delete out._customerCode;
  delete out._salespersonCode;
  delete out._salespersonName;
  return out;
}

async function ensureClosureReasons(client) {
  await client.query(
    `
      insert into quote_closure_reasons (reason_code, reason_name, sort_order, is_active)
      values
        ('no_feedback', 'Closed - No Feedback', 60, true),
        ('project_shelved', 'Closed - Project Shelved', 35, true),
        ('another_quote', 'Another Quote', 55, true)
      on conflict (reason_code) do update
      set reason_name = excluded.reason_name,
          sort_order = excluded.sort_order,
          is_active = true,
          updated_at = now()
    `
  );
  const r = await client.query(`select id, reason_code from quote_closure_reasons`);
  return new Map(r.rows.map((row) => [row.reason_code, row.id]));
}

async function loadProductCatalog(client) {
  // pg Client forbids concurrent queries on one connection — run sequentially.
  const products = await client.query(
    `
      select
        id, category_id, group_id, item_code, item_name, item_type,
        hsn_no, gst_pct, list_price, sku
      from products
      where coalesce(is_active, true) = true
    `
  );
  const groups = await client.query(
    `
      select id, category_id, group_name
      from product_groups
      where coalesce(is_active, true) = true
    `
  );
  const categories = await client.query(
    `
      select id, category_name
      from product_categories
      where coalesce(is_active, true) = true
    `
  );
  return indexCatalog({
    products: products.rows,
    groups: groups.rows,
    categories: categories.rows,
  });
}

function buildParsedLinesForRow(row, catalogIndex) {
  return parseLegacyGroups(
    row.Group,
    {
      products: catalogIndex.products,
      groups: catalogIndex.groups,
      categories: catalogIndex.categories,
    },
    {
      subtotal: parseNumber(row.SubTotal),
      totalPrice: parseNumber(row.TotalPrice),
      gstRate: parseNumber(row.GSTRate),
      quantity: parseNumber(row.Quantity),
    }
  );
}

async function ensureLatestRevision(client, quoteId, row, currencyId) {
  const existing = await client.query(
    `
      select id, revision_no
      from quote_revisions
      where quote_id = $1 and is_latest = true
      order by revision_no desc
      limit 1
    `,
    [quoteId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const quotationDate = parseLegacyDate(row.QuotationDate);
  const gstRate = parseNumber(row.GSTRate) || 0;
  const subtotal = parseNumber(row.SubTotal) || 0;
  const gstAmount = parseNumber(row.GSTAmount);
  const totalPrice = parseNumber(row.TotalPrice) || 0;
  const taxTotal =
    gstAmount != null && Number.isFinite(gstAmount)
      ? gstAmount
      : Number(((subtotal * gstRate) / 100).toFixed(2));
  const grand = totalPrice > 0 ? totalPrice : Number((subtotal + taxTotal).toFixed(2));

  const inserted = await client.query(
    `
      insert into quote_revisions (
        quote_id, revision_no, revision_status, pricing_display_mode,
        base_currency_id, quote_currency_id,
        subtotal_base, subtotal_quote, tax_total_base, tax_total_quote,
        grand_total_base, grand_total_quote,
        prepared_at, issued_at, is_latest
      )
      values (
        $1, 1, 'issued', 'group_subtotals',
        $2, $2,
        $3, $3, $4, $4,
        $5, $5,
        coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()), true
      )
      returning id, revision_no
    `,
    [quoteId, currencyId, subtotal, taxTotal, grand, quotationDate]
  );
  return inserted.rows[0];
}

async function insertLegacyQuoteLines(client, revisionId, parsed) {
  const components = parsed?.components || [];
  if (!components.length) return 0;

  let inserted = 0;
  for (const line of components) {
    await client.query(
      `
        insert into quote_lines (
          quote_revision_id, line_no, product_id, item_code, item_name, line_description,
          hsn_no, qty, unit_price_base, unit_price_quote, gst_pct,
          line_total_base, line_total_quote, scope_type
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$11,'included')
      `,
      [
        revisionId,
        line.line_no,
        line.product_id || null,
        line.item_code,
        line.item_name,
        line.line_description || `Legacy package component: ${line.label}`,
        line.hsn_no || null,
        line.qty || 1,
        line.unit_price || 0,
        line.gst_pct != null ? line.gst_pct : 18,
        line.line_total || 0,
      ]
    );
    inserted += 1;
  }

  const totals = await client.query(
    `
      select
        coalesce(sum(line_total_quote), 0)::numeric as subtotal_quote,
        coalesce(sum(line_total_quote * coalesce(gst_pct, 0) / 100.0), 0)::numeric as tax_total_quote
      from quote_lines
      where quote_revision_id = $1
        and coalesce(scope_type, 'included') = 'included'
    `,
    [revisionId]
  );
  const subtotal = Number(totals.rows[0]?.subtotal_quote || 0);
  const tax = Number(Number(totals.rows[0]?.tax_total_quote || 0).toFixed(2));
  const grand = Number((subtotal + tax).toFixed(2));
  await client.query(
    `
      update quote_revisions
      set
        subtotal_base = $2,
        subtotal_quote = $2,
        tax_total_base = $3,
        tax_total_quote = $3,
        grand_total_base = $4,
        grand_total_quote = $4
      where id = $1
    `,
    [revisionId, subtotal, tax, grand]
  );

  return inserted;
}

/**
 * Backfill quote_lines from legacy Group for quotes that have a latest revision
 * with zero lines. Never overwrites SmartQuoteBuilder / manually entered lines.
 */
async function ensureLegacyLinesForQuote(client, quote, row, catalogIndex, currencyId, stats) {
  const revision = await ensureLatestRevision(client, quote.id, row, currencyId);
  const lineCount = await client.query(
    `select count(*)::int as n from quote_lines where quote_revision_id = $1`,
    [revision.id]
  );
  if (Number(lineCount.rows[0]?.n || 0) > 0) {
    stats.lines_skipped_existing += 1;
    return;
  }

  const parsed = buildParsedLinesForRow(row, catalogIndex);
  if (!parsed.component_count) {
    stats.lines_skipped_empty_group += 1;
    return;
  }

  const inserted = await insertLegacyQuoteLines(client, revision.id, parsed);
  stats.lines_inserted += inserted;
  stats.quotes_lined += 1;
  stats.components_mapped += parsed.mapped_count;
  stats.components_custom += parsed.custom_count;
}

async function resolveCurrencyId(client) {
  const r = await client.query(
    `
      select id
      from currencies
      where upper(currency_code) in ('INR', 'RS', '₹')
      order by case when upper(currency_code) = 'INR' then 0 else 1 end, id
      limit 1
    `
  );
  if (r.rows[0]?.id) return r.rows[0].id;
  const any = await client.query(`select id from currencies order by id limit 1`);
  return any.rows[0]?.id || null;
}

async function createShellQuoteFromLegacy(client, row, {
  companyId,
  customerId,
  currencyId,
  reasonIds,
}) {
  const quoteNumber = String(row.QuotationNo || "").trim();
  if (!quoteNumber || !customerId || !currencyId) return null;

  // Partial unique index (company_id, quote_number) WHERE quote_number IS NOT NULL
  // cannot be targeted by plain ON CONFLICT (company_id, quote_number) — select first.
  const existing = await client.query(
    `
      select id, company_id, quote_number, quote_status, closure_reason_id, closure_remarks
      from quote_headers
      where company_id = $1 and upper(quote_number) = upper($2)
      limit 1
    `,
    [companyId, quoteNumber]
  );
  if (existing.rows[0]) return existing.rows[0];

  const mapped = mapJoshStatus(row.Status);
  const reasonId = mapped.reasonCode ? reasonIds.get(mapped.reasonCode) || null : null;
  const remarks = String(row.FinalRemarks || "").trim() || null;
  const quotationDate = parseLegacyDate(row.QuotationDate);

  try {
    const header = await client.query(
      `
        insert into quote_headers (
          company_id, quote_number, customer_id, attention_to,
          quote_status, closure_reason_id, closure_remarks,
          quote_origin, created_at, updated_at
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7,
          'standard', coalesce($8::timestamptz, now()), now()
        )
        returning id, company_id, quote_number, quote_status, closure_reason_id, closure_remarks
      `,
      [
        companyId,
        quoteNumber,
        customerId,
        String(row.ContactPerson || "").trim() || null,
        mapped.quoteStatus === "issued" ? "issued" : mapped.quoteStatus,
        mapped.quoteStatus === "closed" ? reasonId : null,
        remarks,
        quotationDate,
      ]
    );
    return header.rows[0] || null;
  } catch (err) {
    // Race / duplicate under partial unique index
    if (err && (err.code === "23505" || /unique/i.test(String(err.message || "")))) {
      const again = await client.query(
        `
          select id, company_id, quote_number, quote_status, closure_reason_id, closure_remarks
          from quote_headers
          where company_id = $1 and upper(quote_number) = upper($2)
          limit 1
        `,
        [companyId, quoteNumber]
      );
      return again.rows[0] || null;
    }
    throw err;
  }
}

async function applyToDatabase({ batch, filePath, cleaned, archived, summary, cutoffDate, companyId }) {
  const { pool } = require("../src/db/pool");
  const client = await pool.connect();
  const dbSummary = {
    staged: 0,
    matched: 0,
    updated: 0,
    test_cancelled: 0,
    skipped_terminal: 0,
    missing_in_josh: 0,
    shells_created: 0,
    quotes_lined: 0,
    lines_inserted: 0,
    lines_skipped_existing: 0,
    lines_skipped_empty_group: 0,
    components_mapped: 0,
    components_custom: 0,
  };

  try {
    await client.query("begin");
    await ensureClosureReasons(client);

    await client.query(
      `
        insert into legacy_import_batches (import_key, source_folder, dry_run, notes)
        values ($1, $2, false, $3)
        on conflict (import_key) do update
        set source_folder = excluded.source_folder,
            dry_run = false,
            notes = excluded.notes
      `,
      [batch, path.dirname(filePath), "Quotation report hygiene + analytics ingest"]
    );

    await client.query(`delete from legacy_quotes_staging where batch_key = $1`, [batch]);

    for (let i = 0; i < cleaned.length; i += 1) {
      const row = cleaned[i];
      const customer = parseDisplayWithCode(row.Customer);
      const salesperson = parseLegacyActor(row.SalesPerson);
      await client.query(
        `
          insert into legacy_quotes_staging (
            batch_key, row_no, quotation_no, legacy_lead_no, quotation_date, customer_name,
            customer_code, contact_person, contact_no, contact_email, salesperson_code,
            salesperson_name, group_name, quantity, subtotal, gst_rate, gst_amount,
            total_price, city, state, quotation_remarks, follow_up_date, follow_up_remarks,
            status_raw, final_remarks, raw
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
            $19,$20,$21,$22,$23,$24,$25,$26::jsonb
          )
        `,
        [
          batch,
          i + 1,
          row.QuotationNo || null,
          row.LeadNo || null,
          parseLegacyDate(row.QuotationDate),
          customer.name,
          customer.code,
          String(row.ContactPerson || "").trim() || null,
          String(row.ContactNo || "").replace(/\D/g, "") || null,
          String(row.ContactEMail || "").trim().toLowerCase() || null,
          salesperson.code,
          salesperson.name,
          String(row.Group || "").trim() || null,
          parseNumber(row.Quantity),
          parseNumber(row.SubTotal),
          parseNumber(row.GSTRate),
          parseNumber(row.GSTAmount),
          parseNumber(row.TotalPrice),
          String(row.City || "").trim() || null,
          String(row.State || "").trim() || null,
          String(row.QuotationRemarks || "").trim() || null,
          parseLegacyDate(row.FollowUpDate),
          String(row.FollowupRemarks || "").trim() || null,
          String(row.Status || "").trim() || null,
          String(row.FinalRemarks || "").trim() || null,
          JSON.stringify(row),
        ]
      );
      dbSummary.staged += 1;
    }

    const reasonIds = await ensureClosureReasons(client);

    const quoteParams = [];
    let companyFilter = "";
    if (Number.isFinite(companyId) && companyId > 0) {
      quoteParams.push(companyId);
      companyFilter = ` and qh.company_id = $${quoteParams.length}`;
    }

    const existing = await client.query(
      `
        select
          qh.id,
          qh.company_id,
          qh.quote_number,
          qh.quote_status,
          qh.closure_reason_id,
          qh.closure_remarks
        from quote_headers qh
        where qh.quote_number is not null
          ${companyFilter}
      `,
      quoteParams
    );
    const byNumber = new Map(existing.rows.map((r) => [String(r.quote_number).trim().toUpperCase(), r]));

    for (const row of cleaned) {
      const key = String(row.QuotationNo || "").trim().toUpperCase();
      if (!key) continue;
      const quote = byNumber.get(key);
      if (!quote) {
        dbSummary.missing_in_josh += 1;
        continue;
      }
      dbSummary.matched += 1;

      const mapped = mapJoshStatus(row.Status);
      const current = String(quote.quote_status || "").toLowerCase();
      const openish = ["draft", "issued", "sent", "approved", "pending_approval", "lapsed"].includes(current);

      // Never downgrade converted/cancelled
      if (current === "converted" || current === "cancelled") {
        dbSummary.skipped_terminal += 1;
        continue;
      }

      const remarks =
        String(row.FinalRemarks || "").trim() ||
        (row.HygieneAction === "AUTO_CLOSED_NO_FEEDBACK" ? AUTO_CLOSE_REMARK : null);
      const reasonId = mapped.reasonCode ? reasonIds.get(mapped.reasonCode) || null : null;

      // Active pipeline hygiene: only close/convert — never promote blank/open report rows to issued
      if (mapped.quoteStatus === "issued") {
        continue;
      }

      if (mapped.quoteStatus === "converted") {
        if (!openish) {
          dbSummary.skipped_terminal += 1;
          continue;
        }
        await client.query(
          `
            update quote_headers
            set quote_status = 'converted',
                closure_remarks = case
                  when $2::text is null or $2 = '' then closure_remarks
                  when coalesce(closure_remarks, '') = '' then $2
                  when position($2 in coalesce(closure_remarks, '')) > 0 then closure_remarks
                  else closure_remarks || ' | ' || $2
                end,
                updated_at = now()
            where id = $1
          `,
          [quote.id, remarks]
        );
        dbSummary.updated += 1;
        continue;
      }

      // closed (incl. Closed - No Feedback / Lost / Shelved)
      if (!openish && current !== "closed") {
        dbSummary.skipped_terminal += 1;
        continue;
      }

      await client.query(
        `
          update quote_headers
          set quote_status = 'closed',
              closure_reason_id = coalesce($2, closure_reason_id),
              closure_remarks = case
                when $3::text is null or $3 = '' then closure_remarks
                when coalesce(closure_remarks, '') = '' then $3
                when position($3 in coalesce(closure_remarks, '')) > 0 then closure_remarks
                else closure_remarks || ' | ' || $3
              end,
              updated_at = now()
          where id = $1
        `,
        [quote.id, reasonId, remarks]
      );

      try {
        await client.query(
          `
            insert into audit_logs (
              company_id, actor_email, actor_name, action_type, module,
              target_table, target_id, old_payload, new_payload, status, remarks, created_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'success', $10, now())
          `,
          [
            quote.company_id,
            "system@josh.hygiene",
            "Quotation Report Hygiene",
            "UPDATE",
            "QUOTES",
            "quote_headers",
            String(quote.id),
            JSON.stringify({ quote_status: quote.quote_status, closure_reason_id: quote.closure_reason_id }),
            JSON.stringify({
              quote_status: "closed",
              closure_reason_id: reasonId,
              hygiene_action: row.HygieneAction,
              source_status: row.Status,
            }),
            remarks || `Hygiene sync from ${path.basename(filePath)}`,
          ]
        );
      } catch {
        // audit_logs may differ by environment; hygiene update still stands
      }

      dbSummary.updated += 1;
    }

    // ── Catalog-mapped Group → quote_lines backfill (and shell create for missing) ──
    const catalogIndex = await loadProductCatalog(client);
    const currencyId = await resolveCurrencyId(client);
    if (!currencyId) {
      throw new Error("No currency master row found; cannot create quote revisions/lines.");
    }

    const customerRes = await client.query(`select id, customer_code, customer_name from customers`);
    const customerByCode = new Map(
      customerRes.rows.map((r) => [String(r.customer_code || "").trim().toUpperCase(), r])
    );

    // Refresh quote map after status updates
    const refreshed = await client.query(
      `
        select
          qh.id,
          qh.company_id,
          qh.quote_number,
          qh.quote_status,
          qh.closure_reason_id,
          qh.closure_remarks
        from quote_headers qh
        where qh.quote_number is not null
          ${companyFilter}
      `,
      quoteParams
    );
    for (const r of refreshed.rows) {
      byNumber.set(String(r.quote_number).trim().toUpperCase(), r);
    }

    const effectiveCompanyId =
      Number.isFinite(companyId) && companyId > 0
        ? companyId
        : refreshed.rows.find((r) => r.company_id)?.company_id || null;

    for (const row of cleaned) {
      const key = String(row.QuotationNo || "").trim().toUpperCase();
      if (!key) continue;

      let quote = byNumber.get(key) || null;
      if (!quote) {
        const customer = parseDisplayWithCode(row.Customer);
        const customerRow = customer.code
          ? customerByCode.get(String(customer.code).toUpperCase()) || null
          : null;
        if (customerRow && effectiveCompanyId) {
          quote = await createShellQuoteFromLegacy(client, row, {
            companyId: effectiveCompanyId,
            customerId: customerRow.id,
            currencyId,
            reasonIds,
          });
          if (quote) {
            byNumber.set(key, quote);
            dbSummary.shells_created += 1;
            dbSummary.missing_in_josh = Math.max(0, dbSummary.missing_in_josh - 1);
          }
        }
      }

      if (!quote) continue;
      if (String(quote.quote_status || "").toLowerCase() === "cancelled") continue;

      await ensureLegacyLinesForQuote(client, quote, row, catalogIndex, currencyId, dbSummary);
    }

    // Cancel matching test quotes so they leave win/loss + price-reference + active desks
    for (const row of archived) {
      const key = String(row.QuotationNo || "").trim().toUpperCase();
      if (!key) continue;
      const quote = byNumber.get(key);
      if (!quote) continue;
      const current = String(quote.quote_status || "").toLowerCase();
      if (current === "cancelled") continue;
      if (current === "converted") {
        // Do not cancel converted commercial history; leave but exclude via cancelled only when safe
        continue;
      }
      await client.query(
        `
          update quote_headers
          set quote_status = 'cancelled',
              closure_remarks = case
                when coalesce(closure_remarks, '') = '' then $2
                when position($2 in coalesce(closure_remarks, '')) > 0 then closure_remarks
                else closure_remarks || ' | ' || $2
              end,
              updated_at = now()
          where id = $1
        `,
        [quote.id, "Archived test/dummy quotation (excluded from analytics). Source: QuotationReport hygiene."]
      );
      dbSummary.test_cancelled += 1;
    }

    await client.query(
      `
        insert into quotation_report_hygiene_runs (
          batch_key, source_file, cutoff_date, total_rows, test_archived, auto_closed,
          db_matched, db_updated, db_test_cancelled, summary_json
        )
        values ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10::jsonb)
        on conflict (batch_key) do update set
          source_file = excluded.source_file,
          cutoff_date = excluded.cutoff_date,
          total_rows = excluded.total_rows,
          test_archived = excluded.test_archived,
          auto_closed = excluded.auto_closed,
          db_matched = excluded.db_matched,
          db_updated = excluded.db_updated,
          db_test_cancelled = excluded.db_test_cancelled,
          summary_json = excluded.summary_json
      `,
      [
        batch,
        path.basename(filePath),
        cutoffDate.toISOString().slice(0, 10),
        summary.total_rows,
        summary.test_archived,
        summary.auto_closed,
        dbSummary.matched,
        dbSummary.updated,
        dbSummary.test_cancelled,
        JSON.stringify({ excel: summary, db: dbSummary }),
      ]
    );

    await client.query("commit");
    return dbSummary;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "../..");
  const filePath =
    args.file ||
    path.resolve(repoRoot, "QuotationReport_07-Sep-2026.xlsx");
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const cutoffDate = new Date(`${args.cutoff}T00:00:00.000Z`);
  if (Number.isNaN(cutoffDate.getTime())) {
    console.error(`Invalid cutoff: ${args.cutoff}`);
    process.exit(1);
  }

  const outDir = args.outDir || path.dirname(filePath);
  fs.mkdirSync(outDir, { recursive: true });

  const { archived, cleaned, summary } = processWorkbook(filePath, cutoffDate);

  const cleanPath = path.join(outDir, "QuotationReport_Clean_AutoClosed.xlsx");
  const archivePath = path.join(outDir, "QuotationReport_TestArchive.xlsx");
  const summaryPath = path.join(outDir, "QuotationReport_Hygiene_Summary.json");

  // Clean sheet matches analytics columns; HygieneAudit sheet keeps mapping provenance.
  const cleanExport = cleaned.map((row) => {
    const { HygieneAction, JoshQuoteStatus, JoshClosureReasonCode, ...rest } = row;
    return rest;
  });
  const cleanBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(cleanBook, XLSX.utils.json_to_sheet(cleanExport), "Table");
  XLSX.utils.book_append_sheet(
    cleanBook,
    XLSX.utils.json_to_sheet(
      cleaned.map((r) => ({
        QuotationNo: r.QuotationNo,
        HygieneAction: r.HygieneAction,
        Status: r.Status,
        JoshQuoteStatus: r.JoshQuoteStatus,
        JoshClosureReasonCode: r.JoshClosureReasonCode,
        FinalRemarks: r.FinalRemarks,
      }))
    ),
    "HygieneAudit"
  );

  // Parsed Group → line-item preview (no DB catalog during dry Excel pass → custom/code only;
  // --apply remaps against live Product Master).
  const parsedLineRows = [];
  for (const row of cleaned) {
    const parsed = parseLegacyGroups(row.Group, null, {
      subtotal: parseNumber(row.SubTotal),
      totalPrice: parseNumber(row.TotalPrice),
      gstRate: parseNumber(row.GSTRate),
      quantity: parseNumber(row.Quantity),
    });
    for (const line of parsed.components) {
      parsedLineRows.push({
        QuotationNo: row.QuotationNo,
        LeadNo: row.LeadNo,
        GroupRaw: parsed.raw,
        LineNo: line.line_no,
        Component: line.label,
        MatchType: line.match_type,
        ItemCode: line.item_code,
        ItemName: line.item_name,
        Qty: line.qty,
        UnitPrice: line.unit_price,
        LineTotal: line.line_total,
        GstPct: line.gst_pct,
      });
    }
  }
  XLSX.utils.book_append_sheet(
    cleanBook,
    XLSX.utils.json_to_sheet(parsedLineRows),
    "ParsedLines"
  );
  XLSX.writeFile(cleanBook, cleanPath);
  writeWorkbook(archivePath, archived);

  summary.parsed_line_rows = parsedLineRows.length;
  summary.parsed_quotes_with_groups = new Set(parsedLineRows.map((r) => r.QuotationNo)).size;

  const report = {
    source: path.basename(filePath),
    cutoff: args.cutoff,
    outputs: {
      clean: cleanPath,
      archive: archivePath,
      summary: summaryPath,
    },
    summary,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ ok: true, phase: "excel", ...report.summary, outputs: report.outputs }, null, 2));

  if (!args.apply) {
    console.log("Dry-run complete (Excel only). Re-run with --apply to stage/sync Josh DB.");
    return;
  }

  const dbSummary = await applyToDatabase({
    batch: args.batch,
    filePath,
    cleaned,
    archived,
    summary,
    cutoffDate,
    companyId: args.companyId,
  });
  report.db = dbSummary;
  fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, phase: "db", db: dbSummary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
