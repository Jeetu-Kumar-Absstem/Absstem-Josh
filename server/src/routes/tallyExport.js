const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { getCompanyProfile } = require("../services/companyProfile");
const { buildEnvelope } = require("../services/tally/tallyXml");
const {
  resolveLedgers,
  findUnmappedSales,
  findUnmappedReceipts,
  upsertLedgerMaps,
  DEFAULT_SCOPES,
} = require("../services/tally/ledgerMap");
const { buildSalesExport } = require("../services/tally/salesVoucher");
const { buildReceiptExport } = require("../services/tally/receiptVoucher");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  return text;
}

function normalizeExportType(value) {
  const type = String(value || "sales").trim().toLowerCase();
  return type === "receipts" ? "receipts" : "sales";
}

function safeFileSegment(value) {
  return String(value || "document")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
}

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateRange(req) {
  const from = normalizeDate(req.query.from) || monthStartIso();
  const to = normalizeDate(req.query.to) || todayIso();
  if (from > to) {
    const err = new Error("Invalid date range");
    err.status = 400;
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }
  return { from, to };
}

async function getCompanyMeta(client, companyId) {
  const r = await client.query(
    `
      select id, company_code, coalesce(display_name, legal_name, company_code) as company_name
      from companies
      where id = $1 and is_active = true
      limit 1
    `,
    [Number(companyId)]
  );
  return r.rows[0] || null;
}

async function buildExportBundle(client, companyId, exportType, dateFrom, dateTo) {
  const ledgers = await resolveLedgers(client, companyId);
  if (exportType === "receipts") {
    const data = await buildReceiptExport(client, companyId, dateFrom, dateTo, ledgers);
    return {
      ledgers,
      exportType,
      held: [],
      ...data,
      unmapped: findUnmappedReceipts(data.receipts, ledgers),
    };
  }
  const data = await buildSalesExport(client, companyId, dateFrom, dateTo, ledgers);
  return {
    ledgers,
    exportType,
    ...data,
    unmapped: findUnmappedSales(data.invoices, ledgers),
  };
}

router.use(requireAuth);

router.get("/preview", requireScreenAction("tally_export", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  try {
    const exportType = normalizeExportType(req.query.type);
    const { from, to } = parseDateRange(req);
    const bundle = await buildExportBundle(pool, companyId, exportType, from, to);
    const imbalanced = bundle.vouchers.filter((row) => Math.abs(row.balance) >= 0.01).length;

    return res.json({
      ok: true,
      export_type: exportType,
      date_from: from,
      date_to: to,
      voucher_count: bundle.voucherCount,
      total_amount: bundle.totalAmount,
      unmapped_ledgers: bundle.unmapped,
      has_unmapped: bundle.unmapped.length > 0,
      imbalanced_vouchers: imbalanced,
      held_vouchers: bundle.held,
      held_count: bundle.held.length,
      sample_voucher: bundle.sampleVoucher,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/xml", requireScreenAction("tally_export", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  const client = await pool.connect();
  try {
    const exportType = normalizeExportType(req.query.type);
    const { from, to } = parseDateRange(req);
    const bundle = await buildExportBundle(client, companyId, exportType, from, to);
    const company = await getCompanyMeta(client, companyId);
    const profile = await getCompanyProfile(client, companyId);
    const companyName = profile.company_name || company?.company_name || "Company";
    const xml = buildEnvelope({
      companyName,
      vouchers: bundle.vouchers.map((row) => row.xml),
    });

    await client.query(
      `
        insert into tally_export_runs (
          company_id, export_type, date_from, date_to, voucher_count, filters, generated_by
        )
        values ($1, $2, $3::date, $4::date, $5, $6::jsonb, $7)
      `,
      [
        Number(companyId),
        exportType,
        from,
        to,
        bundle.voucherCount,
        JSON.stringify({
          type: exportType,
          from,
          to,
          held_invoice_numbers: bundle.held.map((row) => row.invoice_number),
        }),
        req.user.id || null,
      ]
    );

    const code = safeFileSegment(company?.company_code || "COMPANY");
    const prefix = exportType === "receipts" ? "TALLY_RECEIPTS" : "TALLY_SALES";
    const filename = `${prefix}_${code}_${from}_${to}.xml`;

    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(xml);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/ledger-map", requireScreenAction("tally_export", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  try {
    const ledgers = await resolveLedgers(pool, companyId);
    return res.json({
      ok: true,
      mappings: ledgers.rows,
      defaults: ledgers.listEffectiveDefaults(),
      default_scopes: DEFAULT_SCOPES,
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/ledger-map", requireScreenAction("tally_export", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const saved = await upsertLedgerMaps(client, companyId, req.body?.mappings);
    await client.query("commit");
    const ledgers = await resolveLedgers(pool, companyId);
    return res.json({ ok: true, mappings: saved.length ? saved : ledgers.rows });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
