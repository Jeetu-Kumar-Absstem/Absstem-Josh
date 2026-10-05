const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { sendMail, isMailConfigured } = require("../services/mailer");
const { assertVendorApprovedForProducts } = require("../services/componentAvl");
const { snapshotPurchaseOrderLandedCost } = require("../services/landedCost");
const { assertVendorCompliance } = require("../services/vendorPortal");

const router = express.Router();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  const n = num(value, 0);
  return Math.round(n * 100) / 100;
}

function money4(value) {
  const n = num(value, 0);
  return Math.round(n * 10000) / 10000;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeBool(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(t)) return true;
    if (["0", "false", "no", "n"].includes(t)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function effectiveUnitPrice(line) {
  return money4(num(line.unit_price, 0) + num(line.freight_per_unit, 0));
}

function canAccessVendorQuote(req, quote) {
  if (!quote) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "vendor_quotes")) return true;
  return Number(quote.created_by) === Number(req.user.id);
}

async function getDefaultCurrencyId(client) {
  const r = await client.query(
    `select id from currencies where upper(coalesce(currency_code, '')) = 'INR' order by id asc limit 1`
  );
  if (r.rows[0]?.id) return Number(r.rows[0].id);
  const any = await client.query(`select id from currencies order by id asc limit 1`);
  return any.rows[0]?.id ? Number(any.rows[0].id) : null;
}

async function getApprovedRequisitionsWithPending(client, companyId) {
  const r = await client.query(
    `
      with ordered_qty as (
        select
          pol.purchase_requisition_line_id,
          sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id is not null
        group by pol.purchase_requisition_line_id
      ),
      pending as (
        select
          pr.id,
          pr.requisition_number,
          pr.requisition_status,
          pr.department,
          pr.required_by_date,
          pr.purpose,
          count(*) filter (where prl.qty_requested - coalesce(oq.qty_ordered, 0) > 0.0001) as pending_lines,
          sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)) as pending_qty
        from purchase_requisitions pr
        join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
        left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
        where pr.company_id = $1
          and pr.requisition_status in ('approved', 'closed')
        group by pr.id, pr.requisition_number, pr.requisition_status, pr.department, pr.required_by_date, pr.purpose
      )
      select *
      from pending
      where pending_lines > 0
      order by required_by_date nulls last, requisition_number asc
    `,
    [Number(companyId)]
  );
  return r.rows;
}

async function getRequisitionHeaderOrNull(client, requisitionId, companyId) {
  const r = await client.query(
    `
      select pr.*
      from purchase_requisitions pr
      where pr.id = $1 and pr.company_id = $2
      limit 1
    `,
    [requisitionId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getRequisitionPendingLines(client, requisitionId) {
  const r = await client.query(
    `
      with ordered_qty as (
        select
          pol.purchase_requisition_line_id,
          sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id is not null
        group by pol.purchase_requisition_line_id
      )
      select
        prl.*,
        coalesce(oq.qty_ordered, 0) as qty_ordered,
        greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0) as qty_pending
      from purchase_requisition_lines prl
      left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
      where prl.purchase_requisition_id = $1
      order by prl.line_no asc
    `,
    [requisitionId]
  );
  return r.rows;
}

async function getVendorQuoteHeaderOrNull(client, quoteId, companyId) {
  const r = await client.query(
    `
      select
        vq.*,
        v.vendor_code,
        v.company_name as vendor_name,
        v.contact_email as vendor_email,
        pr.requisition_number,
        pr.requisition_status,
        rfq.rfq_number,
        cu.full_name as created_by_name,
        po.po_number
      from vendor_quotes vq
      join vendors v on v.id = vq.vendor_id
      join purchase_requisitions pr on pr.id = vq.purchase_requisition_id
      left join purchase_rfqs rfq on rfq.id = vq.purchase_rfq_id
      left join erp_users cu on cu.id = vq.created_by
      left join purchase_orders po on po.id = vq.purchase_order_id
      where vq.id = $1 and vq.company_id = $2
      limit 1
    `,
    [quoteId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getVendorQuoteLines(client, quoteId) {
  const r = await client.query(
    `
      select
        vql.*,
        (vql.unit_price + vql.freight_per_unit) as effective_unit_price,
        round(((vql.unit_price + vql.freight_per_unit) * vql.qty)::numeric, 2) as line_effective_total
      from vendor_quote_lines vql
      where vql.vendor_quote_id = $1
      order by vql.line_no asc
    `,
    [quoteId]
  );
  return r.rows;
}

function decorateQuote(header, lines) {
  const decoratedLines = (lines || []).map((line) => {
    const effective = effectiveUnitPrice(line);
    return {
      ...line,
      effective_unit_price: effective,
      line_effective_total: money(effective * num(line.qty, 0)),
    };
  });
  const effectiveTotal = money(decoratedLines.reduce((sum, line) => sum + num(line.line_effective_total, 0), 0));
  return {
    ...header,
    lines: decoratedLines,
    effective_total: effectiveTotal,
  };
}

function normalizeIncomingLines(rawLines, prLinesById) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    return Object.values(prLinesById)
      .filter((row) => num(row.qty_pending, 0) > 0.0001)
      .map((row, index) => ({
        purchase_requisition_line_id: Number(row.id),
        line_no: index + 1,
        product_id: row.product_id || null,
        item_code: row.item_code || null,
        item_name: row.item_name || null,
        line_description: row.line_description || null,
        hsn_no: row.hsn_no || null,
        uom: row.uom || null,
        qty: money4(row.qty_pending),
        unit_price: money4(row.estimated_unit_price),
        freight_per_unit: 0,
        gst_pct: money(row.gst_pct),
        notes: null,
      }));
  }

  const out = [];
  let lineNo = 1;
  for (const raw of rawLines) {
    const prLineId = Number(raw.purchase_requisition_line_id);
    const prLine = prLinesById[prLineId];
    if (!prLine) continue;
    const qty = money4(raw.qty != null ? raw.qty : prLine.qty_pending);
    if (qty <= 0) continue;
    out.push({
      purchase_requisition_line_id: prLineId,
      line_no: lineNo,
      product_id: prLine.product_id || null,
      item_code: prLine.item_code || null,
      item_name: prLine.item_name || null,
      line_description: prLine.line_description || null,
      hsn_no: prLine.hsn_no || null,
      uom: prLine.uom || null,
      qty,
      unit_price: money4(raw.unit_price != null ? raw.unit_price : prLine.estimated_unit_price),
      freight_per_unit: money4(raw.freight_per_unit != null ? raw.freight_per_unit : 0),
      gst_pct: money(raw.gst_pct != null ? raw.gst_pct : prLine.gst_pct),
      notes: normalizeText(raw.notes),
    });
    lineNo += 1;
  }
  return out;
}

async function insertQuoteLines(client, quoteId, lines) {
  for (const line of lines) {
    await client.query(
      `
        insert into vendor_quote_lines (
          vendor_quote_id, purchase_requisition_line_id, line_no, product_id,
          item_code, item_name, line_description, hsn_no, uom,
          qty, unit_price, freight_per_unit, gst_pct, notes
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `,
      [
        quoteId,
        line.purchase_requisition_line_id,
        line.line_no,
        line.product_id,
        line.item_code,
        line.item_name,
        line.line_description,
        line.hsn_no,
        line.uom,
        line.qty,
        line.unit_price,
        line.freight_per_unit,
        line.gst_pct,
        line.notes,
      ]
    );
  }
}

async function getRfqDetail(client, rfqId, companyId) {
  const headerRes = await client.query(
    `
      select
        rfq.*,
        pr.requisition_number,
        pr.requisition_status,
        pr.department,
        pr.purpose,
        pr.required_by_date,
        cu.full_name as created_by_name,
        su.full_name as sent_by_name
      from purchase_rfqs rfq
      join purchase_requisitions pr on pr.id = rfq.purchase_requisition_id
      left join erp_users cu on cu.id = rfq.created_by
      left join erp_users su on su.id = rfq.sent_by
      where rfq.id = $1 and rfq.company_id = $2
      limit 1
    `,
    [rfqId, Number(companyId)]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return null;

  const vendorsRes = await client.query(
    `
      select
        rv.*,
        v.vendor_code,
        v.company_name as vendor_name,
        v.contact_email,
        v.contact_phone,
        vq.id as vendor_quote_id,
        vq.quote_number,
        vq.quote_status,
        vq.is_winner,
        vq.purchase_order_id
      from purchase_rfq_vendors rv
      join vendors v on v.id = rv.vendor_id
      left join vendor_quotes vq
        on vq.purchase_rfq_vendor_id = rv.id
       and vq.quote_status <> 'cancelled'
      where rv.purchase_rfq_id = $1
      order by v.company_name asc, rv.id asc
    `,
    [rfqId]
  );

  const lines = await getRequisitionPendingLines(client, header.purchase_requisition_id);
  return { ...header, vendors: vendorsRes.rows, lines };
}

function buildRfqPrintHtml({ rfq, companyName }) {
  const lineRows = (rfq.lines || [])
    .filter((line) => num(line.qty_pending, 0) > 0.0001)
    .map(
      (line) => `
      <tr>
        <td>${escapeHtml(line.line_no)}</td>
        <td>${escapeHtml(line.item_code || "")}</td>
        <td>${escapeHtml(line.item_name || line.line_description || "")}</td>
        <td>${escapeHtml(line.uom || "")}</td>
        <td style="text-align:right">${escapeHtml(num(line.qty_pending, 0))}</td>
      </tr>`
    )
    .join("");

  const vendorRows = (rfq.vendors || [])
    .filter((v) => v.invite_status !== "cancelled")
    .map(
      (v) => `
      <tr>
        <td>${escapeHtml(v.vendor_name || "")}</td>
        <td>${escapeHtml(v.contact_email || v.email_to || "—")}</td>
        <td>${escapeHtml(v.invite_status || "")}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(rfq.rfq_number)} — Request for Quotation</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; color: #1a2332; margin: 32px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.04em; color: #4a5568; }
    .meta { color: #4a5568; font-size: 13px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid #d8e0ec; padding: 8px 10px; text-align: left; }
    th { background: #f4f7fb; }
    .note { margin-top: 20px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 13px; }
    @media print { button { display: none; } body { margin: 16px; } }
  </style>
</head>
<body>
  <button onclick="window.print()" style="margin-bottom:16px;padding:8px 12px;">Print</button>
  <h1>Request for Quotation</h1>
  <div class="meta">
    <div><strong>${escapeHtml(companyName || "Absstem")}</strong></div>
    <div>RFQ: ${escapeHtml(rfq.rfq_number)} &nbsp;|&nbsp; PR: ${escapeHtml(rfq.requisition_number || "")}</div>
    <div>Due: ${escapeHtml(rfq.due_date ? String(rfq.due_date).slice(0, 10) : "—")} &nbsp;|&nbsp; Status: ${escapeHtml(rfq.rfq_status)}</div>
    ${rfq.department ? `<div>Department: ${escapeHtml(rfq.department)}</div>` : ""}
    ${rfq.purpose ? `<div>Purpose: ${escapeHtml(rfq.purpose)}</div>` : ""}
  </div>
  <h2>Items requested</h2>
  <table>
    <thead><tr><th>#</th><th>Code</th><th>Item</th><th>UOM</th><th>Qty</th></tr></thead>
    <tbody>${lineRows || `<tr><td colspan="5">No pending lines</td></tr>`}</tbody>
  </table>
  <h2>Invited vendors</h2>
  <table>
    <thead><tr><th>Vendor</th><th>Email</th><th>Invite</th></tr></thead>
    <tbody>${vendorRows || `<tr><td colspan="3">No vendors</td></tr>`}</tbody>
  </table>
  <div class="note">
    Please quote unit price, freight/landed extras, payment/credit terms, delivery lead time (days), and any compliance notes.
    ${rfq.remarks ? `<div style="margin-top:8px">${escapeHtml(rfq.remarks)}</div>` : ""}
  </div>
</body>
</html>`;
}

function buildRfqMailContent({ rfq, vendorName, requesterName }) {
  const lines = (rfq.lines || [])
    .filter((line) => num(line.qty_pending, 0) > 0.0001)
    .map((line) => `  - ${line.item_code || ""} ${line.item_name || ""} × ${num(line.qty_pending, 0)} ${line.uom || ""}`.trim())
    .join("\n");
  const subject = `RFQ ${rfq.rfq_number} / PR ${rfq.requisition_number} — please quote`;
  const text = `Dear ${vendorName || "Vendor"},

${requesterName || "Purchase"} requests your quotation against ${rfq.rfq_number} (PR ${rfq.requisition_number}).
Due date: ${rfq.due_date ? String(rfq.due_date).slice(0, 10) : "as soon as possible"}

Items:
${lines || "  (see attached / print sheet)"}

Please reply with unit/landed price, payment/credit terms, delivery days, and compliance notes.
${rfq.remarks ? `\nRemarks: ${rfq.remarks}\n` : ""}
— Josh ERP`;
  const html = `<p>Dear ${escapeHtml(vendorName || "Vendor")},</p>
<p><strong>${escapeHtml(requesterName || "Purchase")}</strong> requests your quotation against <strong>${escapeHtml(rfq.rfq_number)}</strong> (PR ${escapeHtml(rfq.requisition_number)}).</p>
<p>Due date: <strong>${escapeHtml(rfq.due_date ? String(rfq.due_date).slice(0, 10) : "as soon as possible")}</strong></p>
<p>Please reply with unit/landed price, payment/credit terms, delivery days, and compliance notes.</p>
${rfq.remarks ? `<p>Remarks: ${escapeHtml(rfq.remarks)}</p>` : ""}
<p style="color:#64748b;font-size:12px">Sent from Josh ERP. Quotes are captured manually by Purchase after your reply.</p>`;
  return { subject, text, html };
}

async function emailRfqVendors({ rfq, vendors, requesterName }) {
  const results = [];
  const mailReady = isMailConfigured();
  for (const vendor of vendors) {
    const to = normalizeText(vendor.email_to) || normalizeText(vendor.contact_email);
    if (!to) {
      results.push({ purchase_rfq_vendor_id: vendor.id, vendor_id: vendor.vendor_id, ok: false, error: "NO_VENDOR_EMAIL" });
      continue;
    }
    if (!mailReady) {
      results.push({ purchase_rfq_vendor_id: vendor.id, vendor_id: vendor.vendor_id, ok: false, error: "SMTP_NOT_CONFIGURED", email_to: to });
      continue;
    }
    try {
      const content = buildRfqMailContent({ rfq, vendorName: vendor.vendor_name, requesterName });
      await sendMail({ to, subject: content.subject, text: content.text, html: content.html });
      results.push({ purchase_rfq_vendor_id: vendor.id, vendor_id: vendor.vendor_id, ok: true, email_to: to });
    } catch (err) {
      results.push({
        purchase_rfq_vendor_id: vendor.id,
        vendor_id: vendor.vendor_id,
        ok: false,
        error: err?.code || err?.message || "EMAIL_FAILED",
        email_to: to,
      });
    }
  }
  return { mail_configured: mailReady, results };
}

router.get("/bootstrap", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const [vendorsRes, requisitions] = await Promise.all([
      pool.query(
        `
          select id, vendor_code, company_name, contact_email, contact_phone
          from vendors
          where company_id = $1 and is_active = true
          order by company_name asc, vendor_code asc nulls last
        `,
        [companyId]
      ),
      getApprovedRequisitionsWithPending(pool, companyId),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      requisitions,
      mail_configured: isMailConfigured(),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/compare/:requisitionId", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const requisitionId = Number(req.params.requisitionId);
    if (!Number.isFinite(requisitionId) || requisitionId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUISITION" });
    }
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const requisition = await getRequisitionHeaderOrNull(pool, requisitionId, companyId);
    if (!requisition) return res.status(404).json({ ok: false, error: "REQUISITION_NOT_FOUND" });
    if (!canAccessCompanyContext(req, requisition)) {
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const prLines = await getRequisitionPendingLines(pool, requisitionId);
    const quotesRes = await pool.query(
      `
        select
          vq.*,
          v.vendor_code,
          v.company_name as vendor_name,
          po.po_number,
          rfq.rfq_number
        from vendor_quotes vq
        join vendors v on v.id = vq.vendor_id
        left join purchase_orders po on po.id = vq.purchase_order_id
        left join purchase_rfqs rfq on rfq.id = vq.purchase_rfq_id
        where vq.purchase_requisition_id = $1
          and vq.company_id = $2
          and vq.quote_status <> 'cancelled'
        order by vq.is_winner desc, v.company_name asc, vq.id asc
      `,
      [requisitionId, companyId]
    );

    const quotes = [];
    for (const header of quotesRes.rows) {
      if (!canAccessVendorQuote(req, header)) continue;
      const lines = await getVendorQuoteLines(pool, header.id);
      quotes.push(decorateQuote(header, lines));
    }

    const rfqsRes = await pool.query(
      `
        select rfq.id, rfq.rfq_number, rfq.rfq_status, rfq.due_date, rfq.sent_at,
          (select count(*)::int from purchase_rfq_vendors rv where rv.purchase_rfq_id = rfq.id and rv.invite_status <> 'cancelled') as vendor_count,
          (select count(*)::int from purchase_rfq_vendors rv where rv.purchase_rfq_id = rfq.id and rv.invite_status = 'responded') as responded_count
        from purchase_rfqs rfq
        where rfq.purchase_requisition_id = $1 and rfq.company_id = $2 and rfq.rfq_status <> 'cancelled'
        order by rfq.created_at desc
      `,
      [requisitionId, companyId]
    );

    return res.json({
      ok: true,
      requisition,
      lines: prLines,
      quotes,
      rfqs: rfqsRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/rfqs", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const requisitionId = Number(req.query.requisition_id);
    const params = [companyId];
    const where = [`rfq.company_id = $1`, `rfq.rfq_status <> 'cancelled'`];
    if (Number.isFinite(requisitionId) && requisitionId > 0) {
      params.push(requisitionId);
      where.push(`rfq.purchase_requisition_id = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          rfq.*,
          pr.requisition_number,
          (select count(*)::int from purchase_rfq_vendors rv where rv.purchase_rfq_id = rfq.id and rv.invite_status <> 'cancelled') as vendor_count,
          (select count(*)::int from purchase_rfq_vendors rv where rv.purchase_rfq_id = rfq.id and rv.invite_status = 'responded') as responded_count
        from purchase_rfqs rfq
        join purchase_requisitions pr on pr.id = rfq.purchase_requisition_id
        where ${where.join(" and ")}
        order by rfq.created_at desc
        limit 100
      `,
      params
    );
    return res.json({ ok: true, rfqs: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/rfqs", requireScreenAction("vendor_quotes", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const requisitionId = Number(body.purchase_requisition_id);
    const vendorIds = Array.isArray(body.vendor_ids)
      ? [...new Set(body.vendor_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
      : [];
    if (!Number.isFinite(requisitionId) || requisitionId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUISITION" });
    }
    if (!vendorIds.length) return res.status(400).json({ ok: false, error: "NO_VENDORS" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const sendEmail = body.send_email !== false;

    await client.query("begin");
    const requisition = await getRequisitionHeaderOrNull(client, requisitionId, companyId);
    if (!requisition) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "REQUISITION_NOT_FOUND" });
    }
    if (!["approved", "closed"].includes(String(requisition.requisition_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_NEEDS_APPROVAL" });
    }

    const vendorsRes = await client.query(
      `
        select id, vendor_code, company_name, contact_email
        from vendors
        where company_id = $1 and is_active = true and id = any($2::int[])
      `,
      [companyId, vendorIds]
    );
    if (vendorsRes.rows.length !== vendorIds.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }

    const numRes = await client.query(`select next_company_document_number($1, 'RFQ') as rfq_number`, [companyId]);
    const rfqNumber = numRes.rows[0]?.rfq_number;
    const insertRes = await client.query(
      `
        insert into purchase_rfqs (
          company_id, rfq_number, purchase_requisition_id, rfq_status,
          due_date, remarks, sent_at, sent_by, created_by
        )
        values ($1,$2,$3,'sent', $4::date, $5, now(), $6, $6)
        returning id
      `,
      [companyId, rfqNumber, requisitionId, body.due_date || null, normalizeText(body.remarks), req.user.id]
    );
    const rfqId = insertRes.rows[0].id;

    for (const vendor of vendorsRes.rows) {
      await client.query(
        `
          insert into purchase_rfq_vendors (
            purchase_rfq_id, vendor_id, invite_status, invited_by, email_to
          )
          values ($1,$2,'invited',$3,$4)
        `,
        [rfqId, vendor.id, req.user.id, vendor.contact_email || null]
      );
    }

    await client.query("commit");

    let rfq = await getRfqDetail(pool, rfqId, companyId);
    let emailSummary = { mail_configured: isMailConfigured(), results: [] };
    if (sendEmail && rfq) {
      emailSummary = await emailRfqVendors({
        rfq,
        vendors: rfq.vendors,
        requesterName: req.user.full_name || req.user.email,
      });
      for (const result of emailSummary.results) {
        if (result.ok) {
          await pool.query(
            `
              update purchase_rfq_vendors
              set email_to = coalesce($2, email_to),
                  email_sent_at = now(),
                  email_error = null,
                  updated_at = now()
              where id = $1
            `,
            [result.purchase_rfq_vendor_id, result.email_to || null]
          );
        } else {
          await pool.query(
            `
              update purchase_rfq_vendors
              set email_to = coalesce($2, email_to),
                  email_error = $3,
                  updated_at = now()
              where id = $1
            `,
            [result.purchase_rfq_vendor_id, result.email_to || null, String(result.error || "EMAIL_FAILED").slice(0, 500)]
          );
        }
      }
      rfq = await getRfqDetail(pool, rfqId, companyId);
    }

    return res.status(201).json({
      ok: true,
      rfq,
      email: emailSummary,
      print_path: `/vendor-quotes/rfqs/${rfqId}/print`,
      desk_hint: "Capture vendor replies manually under Receive quote (no inbound email parsing yet).",
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/rfqs/:id", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const rfq = await getRfqDetail(pool, id, companyId);
    if (!rfq) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, rfq)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    return res.json({ ok: true, rfq });
  } catch (err) {
    return next(err);
  }
});

router.get("/rfqs/:id/print", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const rfq = await getRfqDetail(pool, id, companyId);
    if (!rfq) return res.status(404).send("RFQ not found");
    if (!canAccessCompanyContext(req, rfq)) return res.status(403).send("Forbidden");

    const companyRes = await pool.query(`select company_name from companies where id = $1 limit 1`, [companyId]);
    const html = buildRfqPrintHtml({
      rfq,
      companyName: companyRes.rows[0]?.company_name || "Absstem",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (err) {
    return next(err);
  }
});

router.post("/rfqs/:id/resend-email", requireScreenAction("vendor_quotes", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const onlyVendorIds = Array.isArray(body.vendor_ids)
      ? new Set(body.vendor_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))
      : null;

    const rfq = await getRfqDetail(pool, id, companyId);
    if (!rfq) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const targets = (rfq.vendors || []).filter((v) => {
      if (v.invite_status === "cancelled") return false;
      if (onlyVendorIds && !onlyVendorIds.has(Number(v.vendor_id))) return false;
      return true;
    });
    const emailSummary = await emailRfqVendors({
      rfq,
      vendors: targets,
      requesterName: req.user.full_name || req.user.email,
    });
    for (const result of emailSummary.results) {
      if (result.ok) {
        await pool.query(
          `
            update purchase_rfq_vendors
            set email_to = coalesce($2, email_to), email_sent_at = now(), email_error = null, updated_at = now()
            where id = $1
          `,
          [result.purchase_rfq_vendor_id, result.email_to || null]
        );
      } else {
        await pool.query(
          `
            update purchase_rfq_vendors
            set email_to = coalesce($2, email_to), email_error = $3, updated_at = now()
            where id = $1
          `,
          [result.purchase_rfq_vendor_id, result.email_to || null, String(result.error || "EMAIL_FAILED").slice(0, 500)]
        );
      }
    }
    const refreshed = await getRfqDetail(pool, id, companyId);
    return res.json({ ok: true, rfq: refreshed, email: emailSummary });
  } catch (err) {
    return next(err);
  }
});

async function handleReceiveQuote(req, res, next) {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    let rfqVendor = null;
    let requisitionId = Number(body.purchase_requisition_id);
    let vendorId = Number(body.vendor_id);
    let rfqId = null;

    await client.query("begin");

    if (body.purchase_rfq_vendor_id) {
      const inviteId = Number(body.purchase_rfq_vendor_id);
      const inviteRes = await client.query(
        `
          select rv.*, rfq.purchase_requisition_id, rfq.company_id, rfq.rfq_status, rfq.id as rfq_id
          from purchase_rfq_vendors rv
          join purchase_rfqs rfq on rfq.id = rv.purchase_rfq_id
          where rv.id = $1 and rfq.company_id = $2
          limit 1
        `,
        [inviteId, companyId]
      );
      rfqVendor = inviteRes.rows[0] || null;
      if (!rfqVendor) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "RFQ_INVITE_NOT_FOUND" });
      }
      if (rfqVendor.invite_status === "cancelled") {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "INVITE_CANCELLED" });
      }
      requisitionId = Number(rfqVendor.purchase_requisition_id);
      vendorId = Number(rfqVendor.vendor_id);
      rfqId = Number(rfqVendor.rfq_id);
    }

    if (!Number.isFinite(requisitionId) || requisitionId <= 0 || !Number.isFinite(vendorId) || vendorId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_REQUISITION_OR_VENDOR" });
    }

    const requisition = await getRequisitionHeaderOrNull(client, requisitionId, companyId);
    if (!requisition) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "REQUISITION_NOT_FOUND" });
    }
    if (!["approved", "closed"].includes(String(requisition.requisition_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_NEEDS_APPROVAL" });
    }

    const vendorRes = await client.query(
      `select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`,
      [vendorId, companyId]
    );
    if (!vendorRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }

    const prLines = await getRequisitionPendingLines(client, requisitionId);
    const pending = prLines.filter((row) => num(row.qty_pending, 0) > 0.0001);
    if (!pending.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_FULLY_ORDERED" });
    }
    const prLinesById = {};
    for (const row of pending) prLinesById[Number(row.id)] = row;
    const lines = normalizeIncomingLines(body.lines, prLinesById);
    if (!lines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_QUOTE_LINES" });
    }

    const existing = await client.query(
      `
        select id from vendor_quotes
        where purchase_requisition_id = $1 and vendor_id = $2 and quote_status <> 'cancelled'
        limit 1
      `,
      [requisitionId, vendorId]
    );
    if (existing.rows[0]?.id) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "QUOTE_ALREADY_EXISTS",
        quote_id: existing.rows[0].id,
        detail: "Edit the existing quote for this vendor, or cancel it first.",
      });
    }

    const numRes = await client.query(`select next_company_document_number($1, 'VQ') as quote_number`, [companyId]);
    const quoteNumber = numRes.rows[0]?.quote_number;
    const insertRes = await client.query(
      `
        insert into vendor_quotes (
          company_id, quote_number, purchase_requisition_id, purchase_rfq_id, purchase_rfq_vendor_id,
          vendor_id, quote_status, quote_date, payment_terms, credit_days, delivery_days,
          compliance_ok, compliance_notes, remarks, received_via, created_by
        )
        values ($1,$2,$3,$4,$5,$6,'received',coalesce($7::date, current_date),$8,$9,$10,$11,$12,$13,$14,$15)
        returning id
      `,
      [
        companyId,
        quoteNumber,
        requisitionId,
        rfqId,
        rfqVendor?.id || null,
        vendorId,
        body.quote_date || null,
        normalizeText(body.payment_terms),
        body.credit_days != null && body.credit_days !== "" ? Math.max(0, Math.trunc(num(body.credit_days, 0))) : null,
        body.delivery_days != null && body.delivery_days !== "" ? Math.max(0, Math.trunc(num(body.delivery_days, 0))) : null,
        normalizeBool(body.compliance_ok, true),
        normalizeText(body.compliance_notes),
        normalizeText(body.remarks),
        rfqVendor ? "rfq" : "manual",
        req.user.id,
      ]
    );
    const quoteId = insertRes.rows[0].id;
    await insertQuoteLines(client, quoteId, lines);

    if (rfqVendor?.id) {
      await client.query(
        `
          update purchase_rfq_vendors
          set invite_status = 'responded',
              responded_at = now(),
              updated_at = now()
          where id = $1
        `,
        [rfqVendor.id]
      );
    }

    await client.query("commit");
    const header = await getVendorQuoteHeaderOrNull(pool, quoteId, companyId);
    const quoteLines = await getVendorQuoteLines(pool, quoteId);
    return res.status(201).json({
      ok: true,
      vendor_quote: decorateQuote(header, quoteLines),
      capture_mode: "manual",
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
}

router.post("/receive", requireScreenAction("vendor_quotes", "can_create"), handleReceiveQuote);

router.get("/", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const requisitionId = Number(req.query.requisition_id);
    const params = [companyId];
    const where = [`vq.company_id = $1`, `vq.quote_status <> 'cancelled'`];

    if (ownRecordsOnly(req, "vendor_quotes")) {
      params.push(Number(req.user.id));
      where.push(`vq.created_by = $${params.length}`);
    }
    if (status && ["draft", "received", "selected"].includes(status)) {
      params.push(status);
      where.push(`vq.quote_status = $${params.length}`);
    }
    if (Number.isFinite(requisitionId) && requisitionId > 0) {
      params.push(requisitionId);
      where.push(`vq.purchase_requisition_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(vq.quote_number ilike $${params.length} or pr.requisition_number ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(v.vendor_code, '') ilike $${params.length} or coalesce(rfq.rfq_number, '') ilike $${params.length})`
      );
    }

    const r = await pool.query(
      `
        select
          vq.id,
          vq.quote_number,
          vq.quote_status,
          vq.quote_date,
          vq.payment_terms,
          vq.credit_days,
          vq.delivery_days,
          vq.compliance_ok,
          vq.is_winner,
          vq.received_via,
          vq.purchase_requisition_id,
          vq.purchase_rfq_id,
          vq.vendor_id,
          vq.purchase_order_id,
          vq.created_at,
          v.vendor_code,
          v.company_name as vendor_name,
          pr.requisition_number,
          rfq.rfq_number,
          po.po_number,
          coalesce(sum((vql.unit_price + vql.freight_per_unit) * vql.qty), 0) as effective_total,
          count(vql.id)::int as line_count
        from vendor_quotes vq
        join vendors v on v.id = vq.vendor_id
        join purchase_requisitions pr on pr.id = vq.purchase_requisition_id
        left join purchase_rfqs rfq on rfq.id = vq.purchase_rfq_id
        left join purchase_orders po on po.id = vq.purchase_order_id
        left join vendor_quote_lines vql on vql.vendor_quote_id = vq.id
        where ${where.join(" and ")}
        group by
          vq.id, v.vendor_code, v.company_name, pr.requisition_number, rfq.rfq_number, po.po_number
        order by vq.is_winner desc, vq.created_at desc, vq.id desc
        limit 200
      `,
      params
    );

    return res.json({
      ok: true,
      vendor_quotes: r.rows.map((row) => ({
        ...row,
        effective_total: money(row.effective_total),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("vendor_quotes", "can_create"), handleReceiveQuote);

router.get("/:id", requireScreenAction("vendor_quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const header = await getVendorQuoteHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, header)) {
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessVendorQuote(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getVendorQuoteLines(pool, id);
    return res.json({ ok: true, vendor_quote: decorateQuote(header, lines) });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("vendor_quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existing = await getVendorQuoteHeaderOrNull(client, id, companyId);
    if (!existing) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessVendorQuote(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (["selected", "cancelled"].includes(String(existing.quote_status || "").toLowerCase()) || existing.purchase_order_id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_LOCKED" });
    }

    const nextStatusRaw = typeof body.quote_status === "string" ? body.quote_status.trim().toLowerCase() : "";
    const nextStatus =
      nextStatusRaw && ["draft", "received", "cancelled"].includes(nextStatusRaw) ? nextStatusRaw : existing.quote_status;

    await client.query(
      `
        update vendor_quotes
        set quote_date = coalesce($2::date, quote_date),
            payment_terms = $3,
            credit_days = $4,
            delivery_days = $5,
            compliance_ok = $6,
            compliance_notes = $7,
            remarks = $8,
            quote_status = $9,
            updated_at = now()
        where id = $1 and company_id = $10
      `,
      [
        id,
        body.quote_date || null,
        Object.prototype.hasOwnProperty.call(body, "payment_terms") ? normalizeText(body.payment_terms) : existing.payment_terms,
        Object.prototype.hasOwnProperty.call(body, "credit_days")
          ? body.credit_days != null && body.credit_days !== ""
            ? Math.max(0, Math.trunc(num(body.credit_days, 0)))
            : null
          : existing.credit_days,
        Object.prototype.hasOwnProperty.call(body, "delivery_days")
          ? body.delivery_days != null && body.delivery_days !== ""
            ? Math.max(0, Math.trunc(num(body.delivery_days, 0)))
            : null
          : existing.delivery_days,
        Object.prototype.hasOwnProperty.call(body, "compliance_ok") ? normalizeBool(body.compliance_ok, true) : existing.compliance_ok,
        Object.prototype.hasOwnProperty.call(body, "compliance_notes")
          ? normalizeText(body.compliance_notes)
          : existing.compliance_notes,
        Object.prototype.hasOwnProperty.call(body, "remarks") ? normalizeText(body.remarks) : existing.remarks,
        nextStatus,
        companyId,
      ]
    );

    if (Array.isArray(body.lines)) {
      const prLines = await getRequisitionPendingLines(client, existing.purchase_requisition_id);
      const prLinesById = {};
      for (const row of prLines) prLinesById[Number(row.id)] = row;
      const lines = normalizeIncomingLines(body.lines, prLinesById);
      if (!lines.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "NO_QUOTE_LINES" });
      }
      await client.query(`delete from vendor_quote_lines where vendor_quote_id = $1`, [id]);
      await insertQuoteLines(client, id, lines);
    }

    await client.query("commit");
    const header = await getVendorQuoteHeaderOrNull(pool, id, companyId);
    const quoteLines = await getVendorQuoteLines(pool, id);
    return res.json({ ok: true, vendor_quote: decorateQuote(header, quoteLines) });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/select-winner", requireScreenAction("vendor_quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existing = await getVendorQuoteHeaderOrNull(client, id, companyId);
    if (!existing) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessVendorQuote(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(existing.quote_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_CANCELLED" });
    }
    if (
      String(existing.received_via || "").toLowerCase() === "guest_portal" &&
      String(existing.verification_status || "").toLowerCase() !== "internal_verified"
    ) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_REQUIRES_VERIFICATION" });
    }

    await client.query(
      `
        update vendor_quotes
        set is_winner = false,
            quote_status = case when quote_status = 'selected' then 'received' else quote_status end,
            updated_at = now()
        where purchase_requisition_id = $1
          and company_id = $2
          and id <> $3
          and quote_status <> 'cancelled'
      `,
      [existing.purchase_requisition_id, companyId, id]
    );

    await client.query(
      `
        update vendor_quotes
        set is_winner = true,
            quote_status = 'selected',
            updated_at = now()
        where id = $1 and company_id = $2
      `,
      [id, companyId]
    );

    await client.query("commit");
    const header = await getVendorQuoteHeaderOrNull(pool, id, companyId);
    const lines = await getVendorQuoteLines(pool, id);
    return res.json({ ok: true, vendor_quote: decorateQuote(header, lines) });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/create-po", requireScreenAction("purchase_orders", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    if (!hasScreenAction(req, "vendor_quotes", "can_view")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const quoteLock = await client.query(
      `
        select id, purchase_requisition_id, purchase_order_id, company_id
        from vendor_quotes
        where id = $1 and company_id = $2
        limit 1
        for update
      `,
      [id, companyId]
    );
    if (!quoteLock.rows[0]?.id) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const existing = await getVendorQuoteHeaderOrNull(client, id, companyId);
    if (!existing) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessVendorQuote(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(existing.quote_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_CANCELLED" });
    }
    if (existing.purchase_order_id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PO_ALREADY_CREATED", purchase_order_id: existing.purchase_order_id });
    }
    if (!["approved", "closed"].includes(String(existing.requisition_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_NEEDS_APPROVAL" });
    }

    await client.query(
      `select id from purchase_requisitions where id = $1 and company_id = $2 for update`,
      [existing.purchase_requisition_id, companyId]
    );
    await client.query(
      `select id from purchase_requisition_lines where purchase_requisition_id = $1 for update`,
      [existing.purchase_requisition_id]
    );

    const quoteLines = await getVendorQuoteLines(client, id);
    if (!quoteLines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_QUOTE_LINES" });
    }

    const prPending = await getRequisitionPendingLines(client, existing.purchase_requisition_id);
    const pendingById = {};
    for (const row of prPending) pendingById[Number(row.id)] = row;

    const poLines = [];
    for (const line of quoteLines) {
      const pending = pendingById[Number(line.purchase_requisition_line_id)];
      if (!pending) continue;
      const qty = money4(Math.min(num(line.qty, 0), num(pending.qty_pending, 0)));
      if (qty <= 0.0001) continue;
      const unit = money4(line.unit_price);
      const lineSubtotal = money(qty * unit);
      const lineTax = money(lineSubtotal * (num(line.gst_pct, 0) / 100));
      poLines.push({
        purchase_requisition_line_id: line.purchase_requisition_line_id,
        product_id: line.product_id,
        item_code: line.item_code,
        item_name: line.item_name,
        line_description: line.line_description,
        hsn_no: line.hsn_no,
        uom: line.uom,
        qty,
        unit,
        gst_pct: line.gst_pct,
        lineSubtotal,
        lineTax,
        lineTotal: money(lineSubtotal + lineTax),
      });
    }

    if (!poLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_FULLY_ORDERED" });
    }

    try {
      await assertVendorApprovedForProducts(client, {
        companyId,
        vendorId: existing.vendor_id,
        productIds: poLines.map((line) => line.product_id),
      });
    } catch (avlErr) {
      await client.query("rollback");
      if (avlErr?.code === "UNAPPROVED_VENDOR" || avlErr?.message === "UNAPPROVED_VENDOR") {
        return res.status(400).json({
          ok: false,
          error: "UNAPPROVED_VENDOR",
          detail: avlErr.detail || avlErr.message,
        });
      }
      throw avlErr;
    }
    try {
      await assertVendorCompliance(client, existing.vendor_id);
    } catch (complianceErr) {
      await client.query("rollback");
      if (complianceErr?.code === "VENDOR_COMPLIANCE_LOCKED") {
        return res.status(400).json({
          ok: false,
          error: "VENDOR_COMPLIANCE_LOCKED",
          message: complianceErr.message || "Purchase order blocked. Vendor statutory compliance documents are expired or unverified.",
          detail: complianceErr.detail,
          non_compliant_documents: complianceErr.non_compliant_documents || complianceErr.expired_documents || [],
          expired_documents: complianceErr.expired_documents || [],
        });
      }
      throw complianceErr;
    }

    const currencyId = Number.isFinite(Number(body.order_currency_id))
      ? Number(body.order_currency_id)
      : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    await client.query(
      `
        update vendor_quotes
        set is_winner = false,
            quote_status = case when quote_status = 'selected' then 'received' else quote_status end,
            updated_at = now()
        where purchase_requisition_id = $1
          and company_id = $2
          and id <> $3
          and quote_status <> 'cancelled'
      `,
      [existing.purchase_requisition_id, companyId, id]
    );

    const numRes = await client.query(`select next_company_document_number($1,'PO') as po_number`, [companyId]);
    const poNumber = numRes.rows[0]?.po_number;
    const remarksParts = [];
    if (existing.payment_terms) remarksParts.push(`Payment: ${existing.payment_terms}`);
    if (existing.credit_days != null) remarksParts.push(`Credit: ${existing.credit_days} days`);
    if (existing.delivery_days != null) remarksParts.push(`Delivery: ${existing.delivery_days} days`);
    if (existing.compliance_notes) remarksParts.push(`Compliance: ${existing.compliance_notes}`);
    const remarks =
      normalizeText(body.remarks) ||
      [existing.remarks, remarksParts.length ? `From ${existing.quote_number} — ${remarksParts.join("; ")}` : `From vendor quote ${existing.quote_number}`]
        .filter(Boolean)
        .join("\n");

    const totals = poLines.reduce(
      (acc, line) => {
        acc.subtotal += line.lineSubtotal;
        acc.taxTotal += line.lineTax;
        acc.grandTotal += line.lineTotal;
        return acc;
      },
      { subtotal: 0, taxTotal: 0, grandTotal: 0 }
    );

    const insertRes = await client.query(
      `
        insert into purchase_orders (
          company_id, po_number, purchase_requisition_id, vendor_id, po_status,
          base_currency_id, order_currency_id, po_date,
          subtotal_base, subtotal_order, tax_total_base, tax_total_order,
          grand_total_base, grand_total_order, remarks, created_by
        )
        values ($1,$2,$3,$4,'draft',$5,$6,current_date,$7,$7,$8,$8,$9,$9,$10,$11)
        returning id
      `,
      [
        companyId,
        poNumber,
        existing.purchase_requisition_id,
        existing.vendor_id,
        currencyId,
        currencyId,
        money(totals.subtotal),
        money(totals.taxTotal),
        money(totals.grandTotal),
        remarks,
        req.user.id,
      ]
    );
    const purchaseOrderId = insertRes.rows[0].id;

    let lineNo = 1;
    for (const line of poLines) {
      await client.query(
        `
          insert into purchase_order_lines (
            purchase_order_id, line_no, purchase_requisition_line_id, product_id,
            item_code, item_name, line_description, hsn_no, uom, qty,
            unit_price_base, unit_price_order, gst_pct, line_total_base, line_total_order
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          purchaseOrderId,
          lineNo,
          line.purchase_requisition_line_id,
          line.product_id,
          line.item_code,
          line.item_name,
          line.line_description,
          line.hsn_no,
          line.uom,
          line.qty,
          line.unit,
          line.unit,
          line.gst_pct,
          line.lineSubtotal,
          line.lineSubtotal,
        ]
      );
      lineNo += 1;
    }

    await snapshotPurchaseOrderLandedCost(client, purchaseOrderId, companyId);

    await client.query(
      `
        update vendor_quotes
        set is_winner = true,
            quote_status = 'selected',
            purchase_order_id = $2,
            updated_at = now()
        where id = $1 and company_id = $3
      `,
      [id, purchaseOrderId, companyId]
    );

    const pendingCheck = await client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        )
        select count(*)::integer as pending_lines
        from purchase_requisition_lines prl
        left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
        where prl.purchase_requisition_id = $1
          and prl.qty_requested - coalesce(oq.qty_ordered, 0) > 0.0001
      `,
      [existing.purchase_requisition_id]
    );
    if (Number(pendingCheck.rows[0]?.pending_lines || 0) <= 0) {
      await client.query(
        `
          update purchase_requisitions
          set requisition_status = 'closed', updated_at = now()
          where id = $1 and requisition_status <> 'cancelled'
        `,
        [existing.purchase_requisition_id]
      );
    }

    await client.query("commit");

    const poHeader = await pool.query(
      `
        select po.*, v.company_name as vendor_name
        from purchase_orders po
        left join vendors v on v.id = po.vendor_id
        where po.id = $1 and po.company_id = $2
        limit 1
      `,
      [purchaseOrderId, companyId]
    );
    const header = await getVendorQuoteHeaderOrNull(pool, id, companyId);
    const lines = await getVendorQuoteLines(pool, id);
    return res.status(201).json({
      ok: true,
      purchase_order: poHeader.rows[0] || null,
      vendor_quote: decorateQuote(header, lines),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
