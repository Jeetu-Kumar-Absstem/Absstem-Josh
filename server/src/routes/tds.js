const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 100, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function getTdsOperationsSummary(client, companyId) {
  const company = Number(companyId);
  const [profileGapRes, inactiveSectionRes, zeroDeductionRes, recentDeductionRes, lowerRateRes] = await Promise.all([
    client.query(
      `
        select
          count(*)::int as vendor_count
        from vendors v
        left join tds_sections ts on ts.id = v.tds_section_id
        where v.is_active = true
          and v.tds_enabled = true
          and (
            coalesce(nullif(trim(v.pan_no), ''), '') = ''
            or v.tds_section_id is null
            or coalesce(ts.is_active, false) = false
          )
      `
    ),
    client.query(
      `
        select
          count(*)::int as vendor_count
        from vendors v
        join tds_sections ts on ts.id = v.tds_section_id
        where v.is_active = true
          and v.tds_enabled = true
          and ts.is_active = false
      `
    ),
    client.query(
      `
        select
          count(*)::int as payment_count,
          coalesce(sum(vp.payment_amount), 0) as gross_amount
        from vendor_payments vp
        join vendors v on v.id = vp.vendor_id
        left join tds_sections ts on ts.id = coalesce(vp.tds_section_id, v.tds_section_id)
        where vp.company_id = $1
          and vp.payment_status = 'posted'
          and v.tds_enabled = true
          and coalesce(v.tds_exempt, false) = false
          and coalesce(vp.tds_amount, 0) <= 0.0001
          and (
            coalesce(vp.payment_amount, 0) > coalesce(ts.threshold_amount, 0)
            or coalesce(ts.threshold_amount, 0) = 0
          )
      `,
      [company]
    ),
    client.query(
      `
        select
          count(*)::int as payment_count,
          count(distinct vp.vendor_id)::int as vendor_count,
          coalesce(sum(vp.tds_amount), 0) as tds_amount
        from vendor_payments vp
        where vp.company_id = $1
          and vp.payment_status = 'posted'
          and coalesce(vp.tds_amount, 0) > 0.0001
          and vp.payment_date >= date_trunc('month', current_date)
      `,
      [company]
    ),
    client.query(
      `
        select
          count(*)::int as vendor_count
        from vendors v
        where v.is_active = true
          and v.tds_enabled = true
          and coalesce(v.tds_exempt, false) = false
          and coalesce(v.lower_deduction_rate, 0) > 0.0001
      `
    ),
  ]);

  const profileGap = profileGapRes.rows[0] || {};
  const inactiveSection = inactiveSectionRes.rows[0] || {};
  const zeroDeduction = zeroDeductionRes.rows[0] || {};
  const recentDeduction = recentDeductionRes.rows[0] || {};
  const lowerRate = lowerRateRes.rows[0] || {};

  return {
    profile_gap_vendors: Number(profileGap.vendor_count || 0),
    inactive_section_vendors: Number(inactiveSection.vendor_count || 0),
    zero_deduction_payment_count: Number(zeroDeduction.payment_count || 0),
    zero_deduction_gross_amount: money(zeroDeduction.gross_amount),
    current_month_deducted_payment_count: Number(recentDeduction.payment_count || 0),
    current_month_deducted_vendor_count: Number(recentDeduction.vendor_count || 0),
    current_month_tds_amount: money(recentDeduction.tds_amount),
    lower_rate_vendor_count: Number(lowerRate.vendor_count || 0),
  };
}

async function getTdsOperationsQueue(client, companyId, { bucket = "profile_gaps", q = "", limit = 120 } = {}) {
  const company = Number(companyId);
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "profile_gaps";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (["profile_gaps", "inactive_sections", "lower_rate"].includes(normalizedBucket)) {
    const params = [];
    const where = [`v.is_active = true`, `v.tds_enabled = true`];
    if (normalizedBucket === "profile_gaps") {
      where.push(`(coalesce(nullif(trim(v.pan_no), ''), '') = '' or v.tds_section_id is null or coalesce(ts.is_active, false) = false)`);
    } else if (normalizedBucket === "inactive_sections") {
      where.push(`coalesce(ts.is_active, false) = false`);
    } else {
      where.push(`coalesce(v.tds_exempt, false) = false`);
      where.push(`coalesce(v.lower_deduction_rate, 0) > 0.0001`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(v.company_name ilike $${params.length} or coalesce(v.vendor_code, '') ilike $${params.length} or coalesce(v.pan_no, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          v.id,
          v.vendor_code,
          v.company_name,
          v.pan_no,
          v.tds_enabled,
          v.tds_exempt,
          v.lower_deduction_rate,
          v.tds_section_id,
          ts.section_code,
          ts.section_name,
          ts.default_rate,
          ts.threshold_amount,
          ts.is_active as section_is_active
        from vendors v
        left join tds_sections ts on ts.id = v.tds_section_id
        where ${where.join(" and ")}
        order by v.company_name asc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "vendors",
      rows: r.rows.map((row) => ({
        ...row,
        default_rate: money(row.default_rate),
        threshold_amount: money(row.threshold_amount),
        lower_deduction_rate: money(row.lower_deduction_rate),
      })),
    };
  }

  const params = [company];
  const where = [`vp.company_id = $1`, `vp.payment_status = 'posted'`];
  if (normalizedBucket === "zero_deduction") {
    where.push(`v.tds_enabled = true`);
    where.push(`coalesce(v.tds_exempt, false) = false`);
    where.push(`coalesce(vp.tds_amount, 0) <= 0.0001`);
    where.push(`(coalesce(vp.payment_amount, 0) > coalesce(ts.threshold_amount, 0) or coalesce(ts.threshold_amount, 0) = 0)`);
  } else {
    where.push(`coalesce(vp.tds_amount, 0) > 0.0001`);
    where.push(`vp.payment_date >= date_trunc('month', current_date)`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    where.push(`(v.company_name ilike $${params.length} or vp.payment_number ilike $${params.length} or coalesce(ts.section_code, '') ilike $${params.length})`);
  }

  const r = await client.query(
    `
      select
        vp.id,
        vp.payment_number,
        vp.payment_date,
        vp.payment_amount,
        vp.tds_base_amount,
        vp.tds_rate,
        vp.tds_amount,
        vp.net_payment_amount,
        vp.tds_section_id,
        v.id as vendor_id,
        v.company_name as vendor_name,
        v.pan_no,
        v.tds_enabled,
        v.tds_exempt,
        v.lower_deduction_rate,
        ts.section_code,
        ts.section_name,
        ts.threshold_amount,
        curr.currency_code
      from vendor_payments vp
      join vendors v on v.id = vp.vendor_id
      left join tds_sections ts on ts.id = coalesce(vp.tds_section_id, v.tds_section_id)
      left join currencies curr on curr.id = vp.payment_currency_id
      where ${where.join(" and ")}
      order by vp.payment_date desc, vp.id desc
      limit ${normalizedLimit}
    `,
    params
  );

  return {
    bucket: normalizedBucket,
    queue_type: "payments",
    rows: r.rows.map((row) => ({
      ...row,
      payment_amount: money(row.payment_amount),
      tds_base_amount: money(row.tds_base_amount),
      tds_amount: money(row.tds_amount),
      net_payment_amount: money(row.net_payment_amount),
      threshold_amount: money(row.threshold_amount),
      lower_deduction_rate: money(row.lower_deduction_rate),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("tds", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [sectionsRes, vendorsRes] = await Promise.all([
      pool.query(
        `
          select *
          from tds_sections
          order by section_code asc, id asc
        `
      ),
      pool.query(
        `
          select
            v.id,
            v.vendor_code,
            v.company_name,
            v.pan_no,
            v.tds_enabled,
            v.tds_exempt,
            v.lower_deduction_rate,
            v.tds_section_id,
            ts.section_code,
            ts.section_name
          from vendors v
          left join tds_sections ts on ts.id = v.tds_section_id
          order by v.company_name asc
        `
      ),
    ]);

    return res.json({ ok: true, sections: sectionsRes.rows, vendors: vendorsRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/operations-summary", requireScreenAction("tds", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getTdsOperationsSummary(pool, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/operations-queue", requireScreenAction("tds", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getTdsOperationsQueue(pool, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("tds", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [sectionsRes, summaryRes, paymentsRes] = await Promise.all([
      pool.query(
        `
          select *
          from tds_sections
          order by section_code asc, id asc
        `
      ),
      pool.query(
        `
          select
            vp.vendor_id,
            v.company_name as vendor_name,
            coalesce(sum(vp.payment_amount), 0) as gross_settlement,
            coalesce(sum(vp.tds_amount), 0) as total_tds,
            coalesce(sum(coalesce(nullif(vp.net_payment_amount, 0), vp.payment_amount)), 0) as net_paid
          from vendor_payments vp
          join vendors v on v.id = vp.vendor_id
          where vp.payment_status = 'posted'
            and vp.company_id = $1
          group by vp.vendor_id, v.company_name
          order by v.company_name asc
        `,
        [companyId]
      ),
      pool.query(
        `
          select
            vp.id,
            vp.payment_number,
            vp.payment_date,
            vp.payment_amount,
            vp.tds_base_amount,
            vp.tds_rate,
            vp.tds_amount,
            vp.net_payment_amount,
            v.company_name as vendor_name,
            ts.section_code,
            ts.section_name,
            curr.currency_code
          from vendor_payments vp
          join vendors v on v.id = vp.vendor_id
          left join tds_sections ts on ts.id = vp.tds_section_id
          left join currencies curr on curr.id = vp.payment_currency_id
          where vp.payment_status = 'posted'
            and vp.tds_amount > 0
            and vp.company_id = $1
          order by vp.payment_date desc, vp.id desc
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      sections: sectionsRes.rows,
      vendor_summary: summaryRes.rows.map((row) => ({
        ...row,
        gross_settlement: money(row.gross_settlement),
        total_tds: money(row.total_tds),
        net_paid: money(row.net_paid),
      })),
      payments: paymentsRes.rows.map((row) => ({
        ...row,
        payment_amount: money(row.payment_amount),
        tds_base_amount: money(row.tds_base_amount),
        tds_amount: money(row.tds_amount),
        net_payment_amount: money(row.net_payment_amount),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/sections", requireScreenAction("tds", "can_create"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sectionCode = String(body.section_code || "").trim().toUpperCase();
    const sectionName = String(body.section_name || "").trim();
    if (!sectionCode || !sectionName) return res.status(400).json({ ok: false, error: "SECTION_REQUIRED" });

    const r = await pool.query(
      `
        insert into tds_sections (
          section_code,
          section_name,
          default_rate,
          threshold_amount,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,now())
        returning *
      `,
      [sectionCode, sectionName, Number(body.default_rate || 0), Number(body.threshold_amount || 0), body.is_active !== false]
    );

    return res.status(201).json({ ok: true, section: r.rows[0] });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_SECTION" });
    return next(err);
  }
});

router.put("/sections/:id", requireScreenAction("tds", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sectionCode = String(body.section_code || "").trim().toUpperCase();
    const sectionName = String(body.section_name || "").trim();
    if (!sectionCode || !sectionName) return res.status(400).json({ ok: false, error: "SECTION_REQUIRED" });

    const r = await pool.query(
      `
        update tds_sections
        set section_code = $1,
            section_name = $2,
            default_rate = $3,
            threshold_amount = $4,
            is_active = $5,
            updated_at = now()
        where id = $6
        returning *
      `,
      [sectionCode, sectionName, Number(body.default_rate || 0), Number(body.threshold_amount || 0), body.is_active !== false, id]
    );
    const section = r.rows[0] || null;
    if (!section) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, section });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_SECTION" });
    return next(err);
  }
});

module.exports = router;
