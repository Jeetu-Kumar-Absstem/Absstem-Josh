/**
 * Lead Entry Report hygiene + LeadNo alignment to QuotationReport_Clean_AutoClosed.xlsx.
 *
 * 1) Archive test/dummy leads
 * 2) Align LeadNo → cleaned quotations (preserve conversion: lead → quote → order)
 * 3) Derive Josh lead status from cleaned quote outcome when linked
 * 4) Write LeadEntryReport_Clean_Aligned.xlsx (+ archive + summary)
 * 5) Optionally --apply: stage legacy_leads + upsert leads + link quote_headers.lead_id
 *
 * Usage:
 *   node scripts/process_lead_entry_report_hygiene.js
 *   node scripts/process_lead_entry_report_hygiene.js --apply --company-id=2
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const WON_QUOTE_STATUSES = new Set([
  "converted to order",
  "converted",
  "closed in our favour",
  "converted to order",
]);

const LOST_QUOTE_STATUSES = new Set([
  "closed - no feedback",
  "lost order",
  "loose order",
  "closed - project shelved",
  "another quote",
  "closed",
]);

function parseArgs(argv) {
  const out = {
    leadsFile: null,
    quotesFile: null,
    testArchiveFile: null,
    outDir: null,
    apply: false,
    companyId: null,
    batch: `lead_hygiene_${new Date().toISOString().slice(0, 10)}`,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    else if (token.startsWith("--leads=")) out.leadsFile = path.resolve(token.slice(8));
    else if (token === "--leads" && argv[i + 1]) out.leadsFile = path.resolve(argv[++i]);
    else if (token.startsWith("--quotes=")) out.quotesFile = path.resolve(token.slice(9));
    else if (token === "--quotes" && argv[i + 1]) out.quotesFile = path.resolve(argv[++i]);
    else if (token.startsWith("--test-archive=")) out.testArchiveFile = path.resolve(token.slice(15));
    else if (token === "--test-archive" && argv[i + 1]) out.testArchiveFile = path.resolve(argv[++i]);
    else if (token.startsWith("--out=")) out.outDir = path.resolve(token.slice(6));
    else if (token === "--out" && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
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
  const parts = raw.split(/\s+/).filter(Boolean);
  const dm = parts[0].split("-");
  if (dm.length !== 3) return null;
  const day = Number(dm[0]);
  const mon = monthMap[String(dm[1] || "").slice(0, 3).toUpperCase()];
  let year = Number(dm[2]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(day) || !Number.isFinite(mon) || !Number.isFinite(year)) return null;
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (parts[1]) {
    const t = parts[1].split(":");
    hour = Number(t[0] || 0);
    minute = Number(t[1] || 0);
    second = Number(String(t[2] || "0").replace(/[^0-9]/g, "")) || 0;
    const ampm = String(parts[2] || "").toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }
  const dt = new Date(Date.UTC(year, mon, day, hour, minute, second));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatLegacyDate(dt) {
  if (!dt) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(dt.getUTCDate()).padStart(2, "0")}-${months[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) return digits.slice(-10);
  return digits;
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

function readSheetRows(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames.includes("Table") ? "Table" : wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function writeWorkbook(filePath, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  }
  XLSX.writeFile(wb, filePath);
}

function isTestLead(row, testQuoteNos) {
  const company = String(row.CompanyName || "");
  const leadNo = String(row.LeadNo || "");
  const quoteNo = String(row.QuotationNo || "").trim().toUpperCase();
  if (/\bTEST\s+COMPANY\b/i.test(company)) return true;
  if (/:\s*C12114\b/i.test(company)) return true;
  if (/\bTEST\b/i.test(leadNo)) return true;
  if (/\b(DUMMY|SAMPLE)\s+(LEAD|CUSTOMER|COMPANY)\b/i.test(company)) return true;
  if (quoteNo && testQuoteNos.has(quoteNo)) return true;
  return false;
}

function mapRawLeadStatus(statusRaw, remarks) {
  const text = normalizeText(`${statusRaw || ""} ${remarks || ""}`);
  if (text.includes("spam")) return "spam";
  if (text.includes("duplicate")) return "duplicate";
  if (text.includes("irrelevant") || text.includes("non product inquiry") || text.includes("not required")) {
    return "closed_no_action";
  }
  if (text.includes("lost")) return "lost";
  if (text.includes("follow up") || text.includes("no answer") || text.includes("cold lead") || text.includes("future potential")) {
    return "follow_up";
  }
  if (
    text.includes("qualified") ||
    text.includes("product inquiry") ||
    text.includes("warm lead") ||
    text.includes("hot lead") ||
    text.includes("to be qualified")
  ) {
    return "qualified";
  }
  if (text.includes("needs specific department")) return "follow_up";
  return "new";
}

function quoteOutcome(statusRaw) {
  const key = String(statusRaw || "").trim().toLowerCase();
  if (WON_QUOTE_STATUSES.has(key)) return "order_won";
  if (LOST_QUOTE_STATUSES.has(key)) return "lost";
  if (key) return "quoted";
  return "quoted";
}

function buildPriority(status) {
  if (status === "qualified" || status === "quoted" || status === "order_won") return "high";
  if (status === "follow_up") return "medium";
  return "low";
}

function chooseLatestQuote(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const at = a.quotationDate ? a.quotationDate.getTime() : 0;
    const bt = b.quotationDate ? b.quotationDate.getTime() : 0;
    return bt - at;
  });
  return list[0] || null;
}

function loadCleanQuotes(quotesFile) {
  const rows = readSheetRows(quotesFile);
  const byLeadNo = new Map();
  const byQuoteNo = new Map();
  for (const raw of rows) {
    const quotationNo = String(raw.QuotationNo || "").trim();
    const legacyLeadNo = String(raw.LeadNo || "").trim() || null;
    const statusRaw = String(raw.Status || "").trim() || null;
    const row = {
      quotationNo,
      legacyLeadNo,
      quotationDate: parseLegacyDate(raw.QuotationDate),
      statusRaw,
      finalRemarks: String(raw.FinalRemarks || "").trim() || null,
      customerName: parseDisplayWithCode(raw.Customer).name,
      customerCode: parseDisplayWithCode(raw.Customer).code,
      totalPrice: raw.TotalPrice,
      outcome: quoteOutcome(statusRaw),
      raw,
    };
    if (quotationNo) byQuoteNo.set(quotationNo.toUpperCase(), row);
    if (legacyLeadNo) {
      const list = byLeadNo.get(legacyLeadNo) || [];
      list.push(row);
      byLeadNo.set(legacyLeadNo, list);
    }
  }
  return { rows, byLeadNo, byQuoteNo };
}

function processLeads({ leadsFile, quotesFile, testArchiveFile }) {
  const leads = readSheetRows(leadsFile);
  const quotes = loadCleanQuotes(quotesFile);

  const testQuoteNos = new Set();
  if (testArchiveFile && fs.existsSync(testArchiveFile)) {
    for (const raw of readSheetRows(testArchiveFile)) {
      const q = String(raw.QuotationNo || "").trim().toUpperCase();
      if (q) testQuoteNos.add(q);
    }
  }

  const archived = [];
  const cleaned = [];
  const conversionBridge = [];
  const summary = {
    total_rows: leads.length,
    test_archived: 0,
    matched_by_lead_no: 0,
    matched_by_quote_no: 0,
    unmatched: 0,
    filled_quotation_no: 0,
    by_josh_status: {},
    by_conversion_stage: {},
    orphan_clean_quotes: 0,
  };

  const leadNosSeen = new Set();

  for (const raw of leads) {
    const leadNo = String(raw.LeadNo || "").trim();
    if (!leadNo) continue;
    leadNosSeen.add(leadNo);

    if (isTestLead(raw, testQuoteNos)) {
      archived.push({
        ...raw,
        HygieneAction: "ARCHIVED_TEST",
        HygieneReason: "Test/dummy lead or linked to archived test quotation",
      });
      summary.test_archived += 1;
      continue;
    }

    const explicitQuoteNo = String(raw.QuotationNo || "").trim();
    const byLead = chooseLatestQuote(quotes.byLeadNo.get(leadNo) || []);
    const byQuote = explicitQuoteNo ? quotes.byQuoteNo.get(explicitQuoteNo.toUpperCase()) || null : null;
    const matchedQuote = byLead || byQuote || null;

    let matchConfidence = "open_unmatched";
    if (byLead) {
      matchConfidence = "exact_lead_no";
      summary.matched_by_lead_no += 1;
    } else if (byQuote) {
      matchConfidence = "lead_quote_no";
      summary.matched_by_quote_no += 1;
    } else {
      summary.unmatched += 1;
    }

    let quotationNo = explicitQuoteNo;
    if (!quotationNo && matchedQuote?.quotationNo) {
      quotationNo = matchedQuote.quotationNo;
      summary.filled_quotation_no += 1;
    }

    const rawJoshStatus = mapRawLeadStatus(raw.Status, raw.FinalStatusRemarks);
    let joshStatus = rawJoshStatus;
    let conversionStage = "lead_only";
    let closeReason = String(raw.FinalStatusRemarks || "").trim() || null;

    if (matchedQuote) {
      const outcome = matchedQuote.outcome;
      if (outcome === "order_won") {
        joshStatus = "order_won";
        conversionStage = "lead_quote_order";
      } else if (outcome === "lost") {
        // Preserve spam/duplicate classification; otherwise close for conversion analytics
        if (rawJoshStatus !== "spam" && rawJoshStatus !== "duplicate") {
          joshStatus = "lost";
        }
        conversionStage = "lead_quote_closed";
        closeReason =
          matchedQuote.finalRemarks ||
          `Aligned to cleaned quotation ${matchedQuote.quotationNo} (${matchedQuote.statusRaw || "closed"})`;
      } else {
        if (!["spam", "duplicate", "order_won", "lost"].includes(rawJoshStatus)) {
          joshStatus = "quoted";
        }
        conversionStage = "lead_quoted";
      }
    }

    summary.by_josh_status[joshStatus] = (summary.by_josh_status[joshStatus] || 0) + 1;
    summary.by_conversion_stage[conversionStage] = (summary.by_conversion_stage[conversionStage] || 0) + 1;

    const company = parseDisplayWithCode(raw.CompanyName);
    const manager = parseLegacyActor(raw.LeadManager);
    const leadDate = parseLegacyDate(raw.LeadDate);

    const cleanedRow = {
      ...raw,
      LeadNo: leadNo,
      QuotationNo: quotationNo || "",
      LeadDate: leadDate ? formatLegacyDate(leadDate) : String(raw.LeadDate || "").trim(),
      HygieneAction: matchedQuote ? "ALIGNED_TO_CLEAN_QUOTE" : "KEEP",
      MatchConfidence: matchConfidence,
      LinkedQuotationNo: matchedQuote?.quotationNo || "",
      LinkedQuoteStatus: matchedQuote?.statusRaw || "",
      ConversionStage: conversionStage,
      JoshLeadStatus: joshStatus,
      JoshPriority: buildPriority(joshStatus),
      CloseReason: closeReason || "",
      _companyName: company.name,
      _prospectCode: company.code,
      _managerCode: manager.code,
      _managerName: manager.name,
      _leadDate: leadDate,
      _matchedQuote: matchedQuote,
      _joshStatus: joshStatus,
      _closeReason: closeReason,
      _matchConfidence: matchConfidence,
    };
    cleaned.push(cleanedRow);

    if (matchedQuote) {
      conversionBridge.push({
        LeadNo: leadNo,
        QuotationNo: matchedQuote.quotationNo,
        MatchConfidence: matchConfidence,
        QuoteStatus: matchedQuote.statusRaw || "",
        JoshLeadStatus: joshStatus,
        ConversionStage: conversionStage,
        CompanyName: company.name || "",
        QuoteCustomer: matchedQuote.customerName || "",
        LeadSource: String(raw.LeadSource || "").trim(),
        LeadDate: cleanedRow.LeadDate,
        QuoteDate: matchedQuote.quotationDate ? formatLegacyDate(matchedQuote.quotationDate) : "",
      });
    }
  }

  for (const [leadNo, list] of quotes.byLeadNo.entries()) {
    if (!leadNosSeen.has(leadNo)) summary.orphan_clean_quotes += list.length;
  }

  return { archived, cleaned, conversionBridge, summary, quotes };
}

async function applyToDatabase({ batch, leadsFile, cleaned, archived, summary, companyId }) {
  const { pool } = require("../src/db/pool");
  const client = await pool.connect();
  const dbSummary = {
    staged: 0,
    created: 0,
    updated: 0,
    quote_links: 0,
    quote_link_conflicts: 0,
    contacts: 0,
    missing_quotes_in_josh: 0,
  };

  try {
    await client.query("begin");

    await client.query(
      `
        insert into legacy_import_batches (import_key, source_folder, dry_run, notes)
        values ($1, $2, false, $3)
        on conflict (import_key) do update
        set source_folder = excluded.source_folder,
            dry_run = false,
            notes = excluded.notes
      `,
      [batch, path.dirname(leadsFile), "Lead entry hygiene aligned to cleaned quotations"]
    );

    await client.query(`delete from legacy_leads_staging where batch_key = $1`, [batch]);

    const sourceCache = {
      sourceByName: new Map(
        (await client.query(`select id, source_name from lead_sources`)).rows.map((r) => [
          normalizeText(r.source_name),
          r.id,
        ])
      ),
    };

    async function resolveLeadSourceId(sourceName) {
      const key = normalizeText(sourceName);
      if (!key) return null;
      if (sourceCache.sourceByName.has(key)) return sourceCache.sourceByName.get(key);
      const code = key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "legacy";
      const inserted = await client.query(
        `
          insert into lead_sources (source_code, source_name, is_active)
          values ($1,$2,true)
          on conflict (source_code) do update set source_name = excluded.source_name, is_active = true
          returning id
        `,
        [`legacy_${code}`, String(sourceName || "").trim()]
      );
      sourceCache.sourceByName.set(key, inserted.rows[0].id);
      return inserted.rows[0].id;
    }

    const userRes = await client.query(`select id, email, full_name from erp_users`);
    const userByName = new Map(userRes.rows.map((r) => [normalizeText(r.full_name), r]));
    const customerRes = await client.query(`select id, customer_code, customer_name from customers`);
    const customerByCode = new Map(customerRes.rows.map((r) => [String(r.customer_code || "").trim(), r]));
    const customerByName = new Map(customerRes.rows.map((r) => [normalizeText(r.customer_name), r]));

    const quoteParams = [];
    let companyFilter = "";
    if (Number.isFinite(companyId) && companyId > 0) {
      quoteParams.push(companyId);
      companyFilter = ` and qh.company_id = $${quoteParams.length}`;
    }
    const quoteRes = await client.query(
      `
        select
          qh.id as quote_id,
          qh.quote_number,
          qh.customer_id,
          qh.lead_id,
          so.id as sales_order_id,
          so.so_number,
          so.order_date
        from quote_headers qh
        left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
        left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
        where qh.quote_number is not null
          ${companyFilter}
      `,
      quoteParams
    );
    const quoteByNumber = new Map(quoteRes.rows.map((r) => [String(r.quote_number || "").trim().toUpperCase(), r]));

    for (let i = 0; i < cleaned.length; i += 1) {
      const row = cleaned[i];
      const createdBy = parseLegacyActor(row.CreatedBy);
      const modifiedBy = parseLegacyActor(row.ModifiedBy);
      await client.query(
        `
          insert into legacy_leads_staging (
            batch_key, row_no, legacy_lead_no, legacy_quote_no, lead_manager_code, lead_manager_name,
            company_name, prospect_code, title, contact_name, city, state, country, mobile_no, email,
            lead_source_name, lead_date, follow_up_date, follow_up_remarks, final_status_remarks,
            category, group_name, item_name, industry, requirement, created_by_code, created_by_name,
            created_at_legacy, modified_by_code, modified_by_name, modified_at_legacy, status_raw,
            mailing_status, raw
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::jsonb
          )
        `,
        [
          batch,
          i + 1,
          row.LeadNo,
          row.LinkedQuotationNo || row.QuotationNo || null,
          row._managerCode,
          row._managerName,
          row._companyName || String(row.ContactName || "").trim() || "Legacy Lead",
          row._prospectCode,
          String(row.Title || "").trim() || null,
          String(row.ContactName || "").trim() || null,
          String(row.City || "").trim() || null,
          String(row.State || "").trim() || null,
          String(row.Country || "").trim() || null,
          normalizePhone(row.MobileNo) || null,
          normalizeEmail(row.EMail) || null,
          String(row.LeadSource || "").trim() || null,
          parseLegacyDate(row.LeadDate),
          parseLegacyDate(row.FollowUpDate),
          String(row.FollowUpRemarks || "").trim() || null,
          row._closeReason || String(row.FinalStatusRemarks || "").trim() || null,
          String(row.Category || "").trim() || null,
          String(row.Group || "").trim() || null,
          String(row.Item || "").trim() || null,
          String(row.Industry || "").trim() || null,
          String(row.Requirement || "").trim() || null,
          createdBy.code,
          createdBy.name,
          parseLegacyDate(row.CreatedDate),
          modifiedBy.code,
          modifiedBy.name,
          parseLegacyDate(row.ModifiedDate),
          String(row.Status || "").trim() || null,
          String(row.MailingStatus || "").trim() || null,
          JSON.stringify({
            ...row,
            _matchedQuote: undefined,
            HygieneAction: row.HygieneAction,
            JoshLeadStatus: row.JoshLeadStatus,
            ConversionStage: row.ConversionStage,
          }),
        ]
      );
      dbSummary.staged += 1;
    }

    for (const row of cleaned) {
      const matchedQuote = row._matchedQuote || null;
      const dbQuote = matchedQuote?.quotationNo
        ? quoteByNumber.get(String(matchedQuote.quotationNo).toUpperCase()) || null
        : null;
      if (matchedQuote?.quotationNo && !dbQuote) dbSummary.missing_quotes_in_josh += 1;

      const sourceId = await resolveLeadSourceId(row.LeadSource);
      const assignedTo =
        (row._managerName && userByName.get(normalizeText(row._managerName))?.id) || null;
      const customerFromCode = matchedQuote?.customerCode
        ? customerByCode.get(matchedQuote.customerCode) || null
        : row._prospectCode
          ? customerByCode.get(row._prospectCode) || null
          : null;
      const customerFromName =
        !customerFromCode && (matchedQuote?.customerName || row._companyName)
          ? customerByName.get(normalizeText(matchedQuote?.customerName || row._companyName)) || null
          : null;
      const customer = customerFromCode || customerFromName || null;

      const joshStatus = row._joshStatus;
      const payload = {
        lead_number: row.LeadNo,
        company_name: row._companyName || String(row.ContactName || "").trim() || "Legacy Lead",
        lead_source_id: sourceId,
        customer_id: customer?.id || dbQuote?.customer_id || null,
        status: joshStatus,
        priority: buildPriority(joshStatus),
        assigned_to: assignedTo,
        legacy_lead_no: row.LeadNo,
        legacy_quote_no: matchedQuote?.quotationNo || row.QuotationNo || null,
        legacy_sales_order_no: dbQuote?.so_number || null,
        legacy_customer_code: matchedQuote?.customerCode || row._prospectCode || null,
        legacy_status_raw: String(row.Status || "").trim() || null,
        legacy_owner_raw: row._managerName || null,
        legacy_follow_up_at: parseLegacyDate(row.FollowUpDate),
        legacy_created_at: parseLegacyDate(row.CreatedDate) || parseLegacyDate(row.LeadDate),
        legacy_updated_at: parseLegacyDate(row.ModifiedDate),
        legacy_import_batch: batch,
        legacy_match_confidence: row._matchConfidence,
        close_reason: row._closeReason,
        converted_quote_id: dbQuote?.quote_id || null,
        converted_to_quote_at: matchedQuote ? matchedQuote.quotationDate || parseLegacyDate(row.LeadDate) : null,
        converted_customer_id: customer?.id || dbQuote?.customer_id || null,
        converted_sales_order_id: dbQuote?.sales_order_id || null,
        converted_to_order_at: dbQuote?.order_date || null,
      };

      let leadId = null;
      const existingByLegacy = await client.query(`select id from leads where legacy_lead_no = $1 limit 1`, [
        payload.legacy_lead_no,
      ]);
      if (existingByLegacy.rows[0]) {
        leadId = existingByLegacy.rows[0].id;
      } else {
        const existingByNumber = await client.query(`select id from leads where lead_number = $1 limit 1`, [
          payload.lead_number,
        ]);
        if (existingByNumber.rows[0]) leadId = existingByNumber.rows[0].id;
      }

      if (leadId) {
        await client.query(
          `
            update leads
            set
              company_name = $2,
              lead_source_id = coalesce($3, lead_source_id),
              customer_id = coalesce($4, customer_id),
              status = $5,
              priority = $6,
              assigned_to = coalesce($7, assigned_to),
              updated_at = now(),
              legacy_lead_no = coalesce(legacy_lead_no, $8),
              legacy_quote_no = $9,
              legacy_sales_order_no = coalesce($10, legacy_sales_order_no),
              legacy_customer_code = coalesce($11, legacy_customer_code),
              legacy_status_raw = $12,
              legacy_owner_raw = coalesce($13, legacy_owner_raw),
              legacy_follow_up_at = coalesce($14, legacy_follow_up_at),
              legacy_created_at = coalesce(legacy_created_at, $15),
              legacy_updated_at = coalesce($16, legacy_updated_at),
              legacy_import_batch = $17,
              legacy_match_confidence = $18,
              close_reason = coalesce($19, close_reason),
              converted_quote_id = coalesce($20, converted_quote_id),
              converted_to_quote_at = coalesce($21, converted_to_quote_at),
              converted_customer_id = coalesce($22, converted_customer_id),
              converted_sales_order_id = coalesce($23, converted_sales_order_id),
              converted_to_order_at = coalesce($24, converted_to_order_at)
            where id = $1
          `,
          [
            leadId,
            payload.company_name,
            payload.lead_source_id,
            payload.customer_id,
            payload.status,
            payload.priority,
            payload.assigned_to,
            payload.legacy_lead_no,
            payload.legacy_quote_no,
            payload.legacy_sales_order_no,
            payload.legacy_customer_code,
            payload.legacy_status_raw,
            payload.legacy_owner_raw,
            payload.legacy_follow_up_at,
            payload.legacy_created_at,
            payload.legacy_updated_at,
            payload.legacy_import_batch,
            payload.legacy_match_confidence,
            payload.close_reason,
            payload.converted_quote_id,
            payload.converted_to_quote_at,
            payload.converted_customer_id,
            payload.converted_sales_order_id,
            payload.converted_to_order_at,
          ]
        );
        dbSummary.updated += 1;
      } else {
        const inserted = await client.query(
          `
            insert into leads (
              lead_number, company_name, lead_source_id, customer_id, status, priority, assigned_to,
              legacy_lead_no, legacy_quote_no, legacy_sales_order_no, legacy_customer_code,
              legacy_status_raw, legacy_owner_raw, legacy_follow_up_at, legacy_created_at,
              legacy_updated_at, legacy_import_batch, legacy_match_confidence, close_reason,
              converted_quote_id, converted_to_quote_at, converted_customer_id,
              converted_sales_order_id, converted_to_order_at
            )
            values (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
            )
            returning id
          `,
          [
            payload.lead_number,
            payload.company_name,
            payload.lead_source_id,
            payload.customer_id,
            payload.status,
            payload.priority,
            payload.assigned_to,
            payload.legacy_lead_no,
            payload.legacy_quote_no,
            payload.legacy_sales_order_no,
            payload.legacy_customer_code,
            payload.legacy_status_raw,
            payload.legacy_owner_raw,
            payload.legacy_follow_up_at,
            payload.legacy_created_at,
            payload.legacy_updated_at,
            payload.legacy_import_batch,
            payload.legacy_match_confidence,
            payload.close_reason,
            payload.converted_quote_id,
            payload.converted_to_quote_at,
            payload.converted_customer_id,
            payload.converted_sales_order_id,
            payload.converted_to_order_at,
          ]
        );
        leadId = inserted.rows[0].id;
        dbSummary.created += 1;
      }

      const phone = normalizePhone(row.MobileNo);
      const email = normalizeEmail(row.EMail);
      const contactName = String(row.ContactName || "").trim() || row._companyName || "Legacy Contact";
      if (leadId && (String(row.ContactName || "").trim() || phone || email)) {
        const exists = await client.query(
          `
            select id from lead_contacts
            where lead_id = $1
              and coalesce(lower(full_name), '') = coalesce(lower($2), '')
              and coalesce(lower(email::text), '') = coalesce(lower($3), '')
              and coalesce(phone, '') = coalesce($4, '')
            limit 1
          `,
          [leadId, contactName || "", email || "", phone || ""]
        );
        if (!exists.rows[0]) {
          const primaryCheck = await client.query(
            `select 1 from lead_contacts where lead_id = $1 and is_primary = true limit 1`,
            [leadId]
          );
          await client.query(
            `
              insert into lead_contacts (lead_id, full_name, email, phone, designation, is_primary)
              values ($1,$2,$3,$4,$5,$6)
            `,
            [
              leadId,
              contactName,
              email || null,
              phone || null,
              String(row.Title || "").trim() || null,
              primaryCheck.rows.length === 0,
            ]
          );
          dbSummary.contacts += 1;
        }
      }

      if (leadId && dbQuote?.quote_id) {
        const link = await client.query(
          `
            update quote_headers
            set lead_id = $2, updated_at = now()
            where id = $1
              and (lead_id is null or lead_id = $2)
            returning id
          `,
          [dbQuote.quote_id, leadId]
        );
        if (link.rows.length) dbSummary.quote_links += 1;
        else if (dbQuote.lead_id && Number(dbQuote.lead_id) !== Number(leadId)) {
          dbSummary.quote_link_conflicts += 1;
        }
      }
    }

    // Soft-close archived test leads already in Josh
    for (const row of archived) {
      const leadNo = String(row.LeadNo || "").trim();
      if (!leadNo) continue;
      await client.query(
        `
          update leads
          set status = case when status = 'order_won' then status else 'spam' end,
              close_reason = coalesce(close_reason, $2),
              legacy_import_batch = $3,
              updated_at = now()
          where legacy_lead_no = $1 or lead_number = $1
        `,
        [
          leadNo,
          "Archived test/dummy lead (excluded from conversion analytics). Source: LeadEntryReport hygiene.",
          batch,
        ]
      );
    }

    try {
      await client.query(
        `
          insert into quotation_report_hygiene_runs (
            batch_key, source_file, cutoff_date, total_rows, test_archived, auto_closed,
            db_matched, db_updated, db_test_cancelled, summary_json
          )
          values ($1,$2, current_date, $3,$4,0,$5,$6,$7,$8::jsonb)
          on conflict (batch_key) do update set
            source_file = excluded.source_file,
            total_rows = excluded.total_rows,
            test_archived = excluded.test_archived,
            db_matched = excluded.db_matched,
            db_updated = excluded.db_updated,
            db_test_cancelled = excluded.db_test_cancelled,
            summary_json = excluded.summary_json
        `,
        [
          batch,
          path.basename(leadsFile),
          summary.total_rows,
          summary.test_archived,
          dbSummary.staged,
          dbSummary.created + dbSummary.updated,
          archived.length,
          JSON.stringify({ excel: summary, db: dbSummary, kind: "lead_entry_hygiene" }),
        ]
      );
    } catch {
      // table may not exist until migration 181 is applied
    }

    await client.query(`update legacy_import_batches set applied_at = now(), dry_run = false where import_key = $1`, [
      batch,
    ]);
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
  const leadsFile = args.leadsFile || path.resolve(repoRoot, "LeadEntryReport_07-Sep-2026.xlsx");
  const quotesFile =
    args.quotesFile || path.resolve(repoRoot, "QuotationReport_Clean_AutoClosed.xlsx");
  const testArchiveFile =
    args.testArchiveFile || path.resolve(repoRoot, "QuotationReport_TestArchive.xlsx");

  if (!fs.existsSync(leadsFile)) {
    console.error(`Lead file not found: ${leadsFile}`);
    process.exit(1);
  }
  if (!fs.existsSync(quotesFile)) {
    console.error(`Clean quotation file not found: ${quotesFile}`);
    console.error("Run process_quotation_report_hygiene.js first.");
    process.exit(1);
  }

  const outDir = args.outDir || path.dirname(leadsFile);
  fs.mkdirSync(outDir, { recursive: true });

  const { archived, cleaned, conversionBridge, summary } = processLeads({
    leadsFile,
    quotesFile,
    testArchiveFile: fs.existsSync(testArchiveFile) ? testArchiveFile : null,
  });

  const exportClean = cleaned.map((row) => {
    const {
      _companyName,
      _prospectCode,
      _managerCode,
      _managerName,
      _leadDate,
      _matchedQuote,
      _joshStatus,
      _closeReason,
      _matchConfidence,
      ...rest
    } = row;
    return rest;
  });

  const cleanPath = path.join(outDir, "LeadEntryReport_Clean_Aligned.xlsx");
  const archivePath = path.join(outDir, "LeadEntryReport_TestArchive.xlsx");
  const summaryPath = path.join(outDir, "LeadEntryReport_Hygiene_Summary.json");

  writeWorkbook(cleanPath, [
    ["Table", exportClean],
    ["ConversionBridge", conversionBridge],
  ]);
  writeWorkbook(archivePath, [["Table", archived]]);

  const report = {
    source_leads: path.basename(leadsFile),
    source_quotes: path.basename(quotesFile),
    outputs: { clean: cleanPath, archive: archivePath, summary: summaryPath },
    summary,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, phase: "excel", ...summary, outputs: report.outputs }, null, 2));

  if (!args.apply) {
    console.log("Dry-run complete (Excel only). Re-run with --apply to upsert Josh leads + quote links.");
    return;
  }

  const dbSummary = await applyToDatabase({
    batch: args.batch,
    leadsFile,
    cleaned,
    archived,
    summary,
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
