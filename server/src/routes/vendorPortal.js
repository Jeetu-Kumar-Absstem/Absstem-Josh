const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const { hasScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { sendMail, isMailConfigured } = require("../services/mailer");
const {
  cleanText,
  normalizeDocumentType,
  normalizeEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
  signVendorJwt,
  verifyVendorJwt,
  hashGuestToken,
  createGuestToken,
  saveVendorDocumentFile,
  getVendorComplianceStatus,
} = require("../services/vendorPortal");
const { normalizeDocumentToPdf, generateVendorComplianceReport, generateRfqComparisonReport } = require("../services/pdfGenerator");
const googleDrive = require("../services/googleDrive");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const executiveRouter = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
});

function fail(status, code, detail) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseJsonField(value, code = "INVALID_REQUEST_JSON") {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw fail(400, code);
  }
}

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function vendorAuth(req, res, next) {
  const claims = verifyVendorJwt(bearerToken(req));
  if (!claims?.sub) return res.status(401).json({ ok: false, error: "VENDOR_UNAUTHORIZED" });
  try {
    const result = await pool.query(
      `
        select vu.id, vu.vendor_id, vu.email, vu.status,
               v.company_id, v.vendor_code, v.company_name
        from vendor_users vu
        join vendors v on v.id = vu.vendor_id and v.is_active = true
        where vu.id = $1
        limit 1
      `,
      [Number(claims.sub)]
    );
    const user = result.rows[0] || null;
    if (!user || user.status !== "active") {
      return res.status(403).json({ ok: false, error: user?.status === "pending" ? "VENDOR_PENDING_APPROVAL" : "VENDOR_SUSPENDED" });
    }
    req.vendorUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireInternalVendorAccess(action = "can_view") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (req.user.group_name === "SuperAdmin" || hasScreenAction(req, "vendor_quotes", action)) return next();
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  };
}

async function loadRfq(client, rfqId, companyId, vendorId = null) {
  const headerResult = await client.query(
    `
      select rfq.*, pr.requisition_number, pr.department, pr.purpose, pr.required_by_date,
             c.display_name as company_name
      from purchase_rfqs rfq
      join purchase_requisitions pr on pr.id = rfq.purchase_requisition_id
      left join companies c on c.id = rfq.company_id
      where rfq.id = $1 and rfq.company_id = $2
      limit 1
    `,
    [Number(rfqId), Number(companyId)]
  );
  const header = headerResult.rows[0] || null;
  if (!header) return null;

  const invitationResult = await client.query(
    `
      select rv.id, rv.vendor_id, rv.email_to, rv.invite_status,
             v.vendor_code, v.company_name, v.contact_email
      from purchase_rfq_vendors rv
      join vendors v on v.id = rv.vendor_id
      where rv.purchase_rfq_id = $1
        and ($2::int is null or rv.vendor_id = $2)
      order by rv.id asc
      limit 1
    `,
    [Number(rfqId), vendorId ? Number(vendorId) : null]
  );
  const invitation = invitationResult.rows[0] || null;

  const linesResult = await client.query(
    `
      select
        prl.id,
        prl.line_no,
        prl.product_id,
        prl.item_code,
        prl.item_name,
        prl.line_description,
        prl.hsn_no,
        prl.uom,
        prl.qty_requested,
        prl.estimated_unit_price,
        prl.gst_pct,
        bom_spec.spec_id as component_specification_id,
        cs.spec_code,
        cs.spec_name,
        cs.geometry,
        cs.material,
        cs.pressure_rating
      from purchase_requisition_lines prl
      left join lateral (
        select bl.component_specification_id as spec_id
        from manufacturing_bom_lines bl
        join manufacturing_boms mb on mb.id = bl.bom_id
        where bl.component_product_id = prl.product_id
          and bl.component_specification_id is not null
          and mb.company_id = $2
          and mb.is_active = true
        order by mb.revision_no desc, mb.updated_at desc, mb.id desc, bl.line_no asc
        limit 1
      ) bom_spec on true
      left join component_specifications cs on cs.id = bom_spec.spec_id
      where prl.purchase_requisition_id = $1
      order by prl.line_no asc
    `,
    [Number(header.purchase_requisition_id), Number(companyId)]
  );
  return { ...header, invitation, lines: linesResult.rows };
}

async function loadGuestContext(client, rawToken, { forUpdate = false } = {}) {
  const lock = forUpdate ? " for update" : "";
  const result = await client.query(
    `
      select
        t.*,
        rfq.company_id,
        rfq.rfq_number,
        rfq.rfq_status,
        rfq.purchase_requisition_id,
        rv.vendor_id as invited_vendor_id,
        v.company_name as vendor_name,
        v.vendor_code,
        v.contact_email
      from guest_rfq_tokens t
      join purchase_rfqs rfq on rfq.id = t.rfq_id
      left join purchase_rfq_vendors rv on rv.id = t.purchase_rfq_vendor_id
      left join vendors v on v.id = coalesce(t.vendor_id, rv.vendor_id)
      where t.token_hash = $1
        and t.is_used = false
        and t.expires_at > now()
        and rfq.rfq_status = 'sent'
      ${lock}
      limit 1
    `,
    [hashGuestToken(rawToken)]
  );
  return result.rows[0] || null;
}

async function loadOnboardingContext(client, rawToken, { forUpdate = false } = {}) {
  const lock = forUpdate ? " for update" : "";
  const result = await client.query(
    `
      select t.id, t.vendor_id, t.vendor_email, t.expires_at, t.is_used,
             v.vendor_code, v.company_name, v.contact_name, v.contact_phone,
             v.company_id, vu.id as vendor_user_id, vu.status as vendor_user_status
      from vendor_onboarding_tokens t
      join vendors v on v.id = t.vendor_id and v.is_active = true
      left join vendor_users vu on vu.vendor_id = t.vendor_id and lower(vu.email) = lower(t.vendor_email)
      where t.token_hash = $1
        and t.is_used = false
        and t.expires_at > now()
      ${lock}
      limit 1
    `,
    [hashGuestToken(rawToken)]
  );
  return result.rows[0] || null;
}

async function resolvePortalQuoteLines(client, rfq, rawLines, vendorId) {
  const sourceById = new Map(rfq.lines.map((line) => [Number(line.id), line]));
  if (!Array.isArray(rawLines) || !rawLines.length) throw fail(400, "QUOTE_LINES_REQUIRED");
  const result = [];
  const seenLineIds = new Set();
  let lineNo = 1;
  for (const raw of rawLines) {
    const source = sourceById.get(Number(raw?.purchase_requisition_line_id));
    if (!source) throw fail(400, "INVALID_RFQ_LINE");
    if (seenLineIds.has(Number(source.id))) throw fail(400, "DUPLICATE_RFQ_LINE");
    seenLineIds.add(Number(source.id));
    const qty = Number(raw.qty == null ? source.qty_requested : raw.qty);
    const unitPrice = Number(raw.unit_price);
    const freight = Number(raw.freight_per_unit || 0);
    if (!Number.isFinite(qty) || qty <= 0 || qty > Number(source.qty_requested) + 0.0001) throw fail(400, "INVALID_QUOTE_QTY");
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw fail(400, "INVALID_QUOTE_PRICE");
    if (!Number.isFinite(freight) || freight < 0) throw fail(400, "INVALID_QUOTE_FREIGHT");

    let avlId = null;
    if (source.component_specification_id && vendorId) {
      const avlResult = await client.query(
        `
          select id
          from component_specification_avl
          where component_specification_id = $1
            and vendor_id = $2
            and is_active = true
          order by is_preferred desc, id asc
          limit 1
        `,
        [Number(source.component_specification_id), Number(vendorId)]
      );
      avlId = avlResult.rows[0]?.id || null;
    }
    result.push({
      purchase_requisition_line_id: Number(source.id),
      line_no: lineNo,
      product_id: source.product_id || null,
      item_code: source.item_code || null,
      item_name: source.item_name || null,
      line_description: source.line_description || null,
      hsn_no: source.hsn_no || null,
      uom: source.uom || null,
      qty,
      unit_price: unitPrice,
      freight_per_unit: freight,
      gst_pct: Number(source.gst_pct || 0),
      notes: cleanText(raw.notes, 500) || null,
      component_specification_id: source.component_specification_id || null,
      component_specification_avl_id: avlId,
    });
    lineNo += 1;
  }
  return result;
}

async function savePortalQuote(client, {
  rfq,
  invitation,
  vendorId,
  vendorUserId = null,
  guestTokenId = null,
  receivedVia,
  verificationStatus,
  body,
  lines,
}) {
  if (!vendorId) throw fail(400, "GUEST_VENDOR_NOT_LINKED", "This RFQ token is not linked to a vendor master record.");
  const existingResult = await client.query(
    `
      select id, quote_status
      from vendor_quotes
      where purchase_rfq_id = $1
        and vendor_id = $2
        and quote_status <> 'cancelled'
        and (
          ($3::int is not null and purchase_rfq_vendor_id = $3)
          or ($3::int is null and guest_rfq_token_id = $4)
        )
      limit 1
    `,
    [Number(rfq.id), Number(vendorId), invitation?.id ? Number(invitation.id) : null, guestTokenId ? Number(guestTokenId) : null]
  );
  const existing = existingResult.rows[0] || null;
  if (existing?.quote_status === "selected") throw fail(409, "QUOTE_LOCKED");

  let quoteId;
  if (existing) {
    quoteId = Number(existing.id);
    await client.query(
      `
        update vendor_quotes
        set quote_status = 'received',
            quote_date = coalesce($2::date, current_date),
            payment_terms = $3,
            credit_days = $4,
            delivery_days = $5,
            compliance_notes = $6,
            remarks = $7,
            received_via = $8,
            vendor_user_id = $9,
            guest_rfq_token_id = $10,
            verification_status = $11,
            submitted_at = now(),
            updated_at = now()
        where id = $1
      `,
      [
        quoteId,
        body.quote_date || null,
        cleanText(body.payment_terms, 240) || null,
        Number.isFinite(Number(body.credit_days)) ? Number(body.credit_days) : null,
        Number.isFinite(Number(body.delivery_days)) ? Number(body.delivery_days) : null,
        cleanText(body.compliance_notes, 1000) || null,
        cleanText(body.remarks, 1000) || null,
        receivedVia,
        vendorUserId,
        guestTokenId,
        verificationStatus,
      ]
    );
    await client.query(`delete from vendor_quote_lines where vendor_quote_id = $1`, [quoteId]);
  } else {
    const numberResult = await client.query(`select next_company_document_number($1, 'VQ') as quote_number`, [Number(rfq.company_id)]);
    const quoteNumber = numberResult.rows[0]?.quote_number || `VQ-${Date.now()}`;
    const insertResult = await client.query(
      `
        insert into vendor_quotes (
          company_id, quote_number, purchase_requisition_id, purchase_rfq_id, purchase_rfq_vendor_id,
          vendor_id, quote_status, quote_date, payment_terms, credit_days, delivery_days,
          compliance_ok, compliance_notes, remarks, received_via, created_by,
          vendor_user_id, guest_rfq_token_id, verification_status, submitted_at
        )
        values ($1,$2,$3,$4,$5,$6,'received',coalesce($7::date,current_date),$8,$9,$10,true,$11,$12,$13,null,$14,$15,$16,now())
        returning id
      `,
      [
        Number(rfq.company_id),
        quoteNumber,
        Number(rfq.purchase_requisition_id),
        Number(rfq.id),
        invitation?.id ? Number(invitation.id) : null,
        Number(vendorId),
        body.quote_date || null,
        cleanText(body.payment_terms, 240) || null,
        Number.isFinite(Number(body.credit_days)) ? Number(body.credit_days) : null,
        Number.isFinite(Number(body.delivery_days)) ? Number(body.delivery_days) : null,
        cleanText(body.compliance_notes, 1000) || null,
        cleanText(body.remarks, 1000) || null,
        receivedVia,
        vendorUserId,
        guestTokenId,
        verificationStatus,
      ]
    );
    quoteId = Number(insertResult.rows[0]?.id);
  }

  for (const line of lines) {
    await client.query(
      `
        insert into vendor_quote_lines (
          vendor_quote_id, purchase_requisition_line_id, line_no, product_id,
          item_code, item_name, line_description, hsn_no, uom, qty,
          unit_price, freight_per_unit, gst_pct, notes,
          component_specification_id, component_specification_avl_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
        line.component_specification_id,
        line.component_specification_avl_id,
      ]
    );
  }
  if (invitation?.id) {
    await client.query(
      `update purchase_rfq_vendors set invite_status = 'responded', responded_at = now(), updated_at = now() where id = $1`,
      [Number(invitation.id)]
    );
  }
  return quoteId;
}

async function saveDocuments(client, files, metadata, { vendorId = null, vendorUserId = null, guestTokenId = null, vendorEmail = null, vendorName = null } = {}) {
  if (!Array.isArray(files) || !files.length) return [];
  const parsedMetadata = Array.isArray(metadata) ? metadata : [];
  const saved = [];

  // If vendorName not passed, attempt to fetch from vendors table
  let resolvedVendorName = vendorName;
  if (!resolvedVendorName && vendorId) {
    const vRes = await client.query(`select company_name, vendor_code from vendors where id = $1 limit 1`, [Number(vendorId)]);
    resolvedVendorName = vRes.rows[0]?.company_name || vRes.rows[0]?.vendor_code || `Vendor-${vendorId}`;
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const meta = parsedMetadata[index] || {};
    const documentType = normalizeDocumentType(meta.document_type || meta.type);
    const expiryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(meta.expiry_date || "")) ? String(meta.expiry_date) : null;
    if (!documentType) throw fail(400, "INVALID_DOCUMENT_TYPE");
    if (!expiryDate) throw fail(400, "DOCUMENT_EXPIRY_REQUIRED");

    // 1. Version tag & archive previous documents of the same type for this vendor
    if (vendorId || vendorEmail) {
      await client.query(
        `
          update vendor_documents
          set verification_status = case when verification_status = 'approved' then 'expired' else verification_status end,
              file_name = regexp_replace(file_name, '(\\.pdf)$', '-archived-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '\\1', 'i'),
              updated_at = now()
          where (vendor_id = $1 or ($1 is null and lower(vendor_email) = lower($2)))
            and upper(document_type) = upper($3)
            and verification_status in ('pending', 'approved')
        `,
        [vendorId ? Number(vendorId) : null, vendorEmail || null, documentType]
      );
    }

    // 2. Compress and save to Google Drive with structured naming: {VendorName}_VEND-{VendorId}-{DocumentType}-{ExpiryDate}.pdf
    const normalized = await normalizeDocumentToPdf(file);
    const stored = await saveVendorDocumentFile(
      { ...normalized, size: normalized.buffer.length },
      {
        vendorId,
        tokenId: guestTokenId,
        vendorName: resolvedVendorName,
        documentType,
        expiryDate,
      }
    );

    const result = await client.query(
      `
        insert into vendor_documents (
          vendor_id, vendor_user_id, guest_rfq_token_id, vendor_email,
          document_type, file_path, file_name, mime_type, file_size_bytes, file_size_kb,
          expiry_date, verification_status, is_mandatory
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
        returning id, document_type, expiry_date, verification_status, file_name, file_size_kb, file_size_bytes
      `,
      [
        vendorId ? Number(vendorId) : null,
        vendorUserId ? Number(vendorUserId) : null,
        guestTokenId ? Number(guestTokenId) : null,
        vendorEmail || null,
        documentType,
        stored.filePath,
        stored.fileName,
        stored.mimeType,
        stored.fileSizeBytes,
        Math.round(stored.fileSizeBytes / 1024),
        expiryDate,
        Boolean(meta.is_mandatory || ["GST", "GST_CERTIFICATE", "PAN", "PAN_CARD", "MSME"].includes(documentType)),
      ]
    );
    saved.push(result.rows[0]);
  }
  return saved;
}

router.get("/register/:token", async (req, res, next) => {
  try {
    const context = await loadOnboardingContext(pool, req.params.token);
    if (!context) return res.status(404).json({ ok: false, error: "ONBOARDING_TOKEN_INVALID_OR_EXPIRED" });
    return res.json({
      ok: true,
      vendor: {
        vendor_id: Number(context.vendor_id),
        vendor_code: context.vendor_code,
        company_name: context.company_name,
        contact_name: context.contact_name,
        email: context.vendor_email,
      },
      expires_at: context.expires_at,
      account_exists: Boolean(context.vendor_user_id),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/register/:token", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const password = req.body?.password;
    if (!validatePassword(password)) throw fail(400, "INVALID_PASSWORD", "Use 12–128 characters with uppercase, lowercase, number, and symbol characters.");
    await client.query("begin");
    const context = await loadOnboardingContext(client, req.params.token, { forUpdate: true });
    if (!context) throw fail(404, "ONBOARDING_TOKEN_INVALID_OR_EXPIRED");
    if (context.vendor_user_id && context.vendor_user_status === "active") throw fail(409, "VENDOR_ACCOUNT_ALREADY_ACTIVE");
    const credentials = await hashPassword(password);
    let vendorUser;
    if (context.vendor_user_id) {
      const updated = await client.query(
        `
          update vendor_users
          set password_salt = $1, password_hash = $2, password_algo = 'scrypt',
              status = 'pending', onboarding_token_id = $3, updated_at = now()
          where id = $4
          returning id, email, status, vendor_id
        `,
        [credentials.salt, credentials.hash, Number(context.id), Number(context.vendor_user_id)]
      );
      vendorUser = updated.rows[0];
    } else {
      const inserted = await client.query(
        `
          insert into vendor_users (vendor_id, email, password_salt, password_hash, status, onboarding_token_id)
          values ($1,$2,$3,$4,'pending',$5)
          returning id, email, status, vendor_id
        `,
        [Number(context.vendor_id), context.vendor_email, credentials.salt, credentials.hash, Number(context.id)]
      );
      vendorUser = inserted.rows[0];
    }
    await client.query(`update vendor_onboarding_tokens set is_used = true, used_at = now() where id = $1`, [Number(context.id)]);
    await client.query("commit");
    return res.status(201).json({
      ok: true,
      vendor_user: vendorUser,
      message: "Password set. Procurement must activate your portal account before sign-in.",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/auth/register", async (_req, res) => {
  return res.status(410).json({
    ok: false,
    error: "INVITATION_REQUIRED",
    detail: "Vendor portal access is created from a purchase executive invitation link.",
  });
  /* Legacy open self-registration is intentionally disabled. */
  /*
  try {
    const email = normalizeEmail(req.body?.email);
    const vendorCode = cleanText(req.body?.vendor_code, 80);
    const password = req.body?.password;
    if (!email || !vendorCode || !validatePassword(password)) {
      return res.status(400).json({ ok: false, error: "INVALID_REGISTRATION", detail: "Use a valid vendor code, contact email, and strong password." });
    }
    const vendorResult = await pool.query(
      `
        select id, company_id, vendor_code, company_name
        from vendors
        where lower(vendor_code) = lower($1)
          and lower(contact_email::text) = $2
          and is_active = true
        limit 1
      `,
      [vendorCode, email]
    );
    const vendor = vendorResult.rows[0] || null;
    if (!vendor) return res.status(404).json({ ok: false, error: "VENDOR_CONTACT_NOT_FOUND" });
    const existing = await pool.query(`select id from vendor_users where lower(email) = $1 limit 1`, [email]);
    if (existing.rows[0]) return res.status(409).json({ ok: false, error: "VENDOR_ACCOUNT_EXISTS" });
    const credentials = await hashPassword(password);
    const result = await pool.query(
      `
        insert into vendor_users (vendor_id, email, password_salt, password_hash, status)
        values ($1,$2,$3,$4,'pending')
        returning id, email, status
      `,
      [Number(vendor.id), email, credentials.salt, credentials.hash]
    );
    return res.status(201).json({
      ok: true,
      vendor_user: { ...result.rows[0], vendor_name: vendor.company_name, vendor_code: vendor.vendor_code },
      message: "Registration received. An internal administrator must activate this vendor account.",
    });
  } catch (error) {
    return next(error);
  }
  */
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) return res.status(400).json({ ok: false, error: "INVALID_CREDENTIALS" });
    const result = await pool.query(
      `
        select vu.id, vu.email, vu.password_salt, vu.password_hash, vu.status,
               vu.vendor_id, v.company_id, v.vendor_code, v.company_name
        from vendor_users vu
        join vendors v on v.id = vu.vendor_id and v.is_active = true
        where lower(vu.email) = $1
        limit 1
      `,
      [email]
    );
    const user = result.rows[0] || null;
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });
    }
    if (user.status !== "active") {
      return res.status(403).json({ ok: false, error: user.status === "pending" ? "VENDOR_PENDING_APPROVAL" : "VENDOR_SUSPENDED" });
    }
    await pool.query(`update vendor_users set last_login_at = now(), updated_at = now() where id = $1`, [Number(user.id)]);
    const token = signVendorJwt({ sub: Number(user.id), vendor_id: Number(user.vendor_id) });
    return res.json({
      ok: true,
      token,
      vendor_user: {
        id: Number(user.id),
        email: user.email,
        vendor_id: Number(user.vendor_id),
        company_id: Number(user.company_id),
        vendor_code: user.vendor_code,
        company_name: user.company_name,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/me", vendorAuth, async (req, res, next) => {
  try {
    const compliance = await getVendorComplianceStatus(pool, req.vendorUser.vendor_id);
    return res.json({ ok: true, vendor_user: req.vendorUser, compliance });
  } catch (error) {
    return next(error);
  }
});

router.get("/documents/:id/view", async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isFinite(documentId) || documentId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_DOCUMENT_ID" });
    }

    const docResult = await pool.query(
      `
        select vd.*, v.company_id
        from vendor_documents vd
        left join vendors v on v.id = vd.vendor_id
        where vd.id = $1
        limit 1
      `,
      [documentId]
    );
    const doc = docResult.rows[0] || null;
    if (!doc) return res.status(404).json({ ok: false, error: "DOCUMENT_NOT_FOUND" });

    // Authentication: Either logged-in internal ERP user OR authenticated vendor user
    let isAuthorized = false;

    // Check if internal ERP user session exists
    if (req.user) {
      if (req.user.group_name === "SuperAdmin" || hasScreenAction(req, "vendor_quotes", "can_view") || hasScreenAction(req, "purchase_orders", "can_view") || hasScreenAction(req, "vendors", "can_view")) {
        isAuthorized = true;
      }
    }

    // Check if vendor bearer token exists
    if (!isAuthorized) {
      const claims = verifyVendorJwt(bearerToken(req));
      if (claims?.sub && Number(claims.vendor_id) === Number(doc.vendor_id)) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN", detail: "Authentication required to view compliance document." });
    }

    const dispositionName = String(doc.file_name || "document.pdf").replace(/[\r\n"]/g, "_").slice(0, 180);
    res.setHeader("Content-Type", doc.mime_type || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${dispositionName}"`);

    // Case 1: Stored in Google Drive
    if (String(doc.file_path || "").startsWith("gdrive:")) {
      const driveFileId = doc.file_path.slice(7).trim();
      if (!googleDrive.isDriveConfigured()) {
        return res.status(503).json({ ok: false, error: "DRIVE_NOT_CONFIGURED" });
      }
      const stream = await googleDrive.downloadFileStream(driveFileId);
      return stream.pipe(res);
    }

    // Case 2: Stored in local filesystem
    const resolvedPath = path.isAbsolute(doc.file_path)
      ? doc.file_path
      : path.resolve(__dirname, "../..", doc.file_path);

    if (fs.existsSync(resolvedPath)) {
      return fs.createReadStream(resolvedPath).pipe(res);
    }

    return res.status(404).json({ ok: false, error: "FILE_CONTENT_MISSING" });
  } catch (error) {
    return next(error);
  }
});

router.get("/documents", vendorAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
        select id, document_type, file_name, mime_type, file_size_bytes,
               expiry_date, verification_status, verified_at, created_at
        from vendor_documents
        where vendor_id = $1
        order by expiry_date nulls last, document_type asc, id desc
      `,
      [Number(req.vendorUser.vendor_id)]
    );
    return res.json({ ok: true, documents: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/documents", vendorAuth, upload.single("file"), async (req, res, next) => {
  try {
    const documents = await saveDocuments(pool, [req.file], [{
      document_type: req.body?.document_type,
      expiry_date: req.body?.expiry_date,
    }], {
      vendorId: req.vendorUser.vendor_id,
      vendorUserId: req.vendorUser.id,
      vendorEmail: req.vendorUser.email,
      vendorName: req.vendorUser.company_name || req.vendorUser.vendor_code,
    });
    return res.status(201).json({ ok: true, document: documents[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/rfqs", vendorAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
        select
          rfq.id, rfq.rfq_number, rfq.rfq_status, rfq.due_date, rfq.remarks,
          rv.id as purchase_rfq_vendor_id, rv.invite_status,
          vq.id as vendor_quote_id, vq.quote_number, vq.quote_status,
          vq.verification_status, vq.submitted_at
        from purchase_rfq_vendors rv
        join purchase_rfqs rfq on rfq.id = rv.purchase_rfq_id and rfq.rfq_status = 'sent'
        left join vendor_quotes vq on vq.purchase_rfq_vendor_id = rv.id and vq.quote_status <> 'cancelled'
        where rv.vendor_id = $1
          and rv.invite_status <> 'cancelled'
        order by rfq.due_date nulls last, rfq.id desc
      `,
      [Number(req.vendorUser.vendor_id)]
    );
    return res.json({ ok: true, rfqs: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/rfqs/:id", vendorAuth, async (req, res, next) => {
  try {
    const rfq = await loadRfq(pool, Number(req.params.id), req.vendorUser.company_id, req.vendorUser.vendor_id);
    if (!rfq || !rfq.invitation || rfq.rfq_status !== "sent") return res.status(404).json({ ok: false, error: "RFQ_NOT_FOUND" });
    return res.json({ ok: true, rfq });
  } catch (error) {
    return next(error);
  }
});

router.post("/rfqs/:id/quote", vendorAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rfq = await loadRfq(client, Number(req.params.id), req.vendorUser.company_id, req.vendorUser.vendor_id);
    if (!rfq || !rfq.invitation || rfq.rfq_status !== "sent") throw fail(404, "RFQ_NOT_FOUND");
    const lines = await resolvePortalQuoteLines(client, rfq, req.body?.lines, req.vendorUser.vendor_id);
    const quoteId = await savePortalQuote(client, {
      rfq,
      invitation: rfq.invitation,
      vendorId: req.vendorUser.vendor_id,
      vendorUserId: req.vendorUser.id,
      receivedVia: "portal",
      verificationStatus: "pending_portal_verification",
      body: req.body || {},
      lines,
    });
    await client.query("commit");
    return res.status(201).json({ ok: true, quote_id: quoteId, status: "Pending Internal Verification" });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/guest/:token", async (req, res, next) => {
  try {
    const context = await loadGuestContext(pool, req.params.token);
    if (!context) return res.status(404).json({ ok: false, error: "GUEST_TOKEN_INVALID_OR_EXPIRED" });
    const rfq = await loadRfq(pool, context.rfq_id, context.company_id, context.vendor_id || context.invited_vendor_id);
    return res.json({
      ok: true,
      guest: {
        token_expires_at: context.expires_at,
        vendor_email: context.vendor_email,
        vendor_name: context.vendor_name,
      },
      rfq,
    });
  } catch (error) {
    return next(error);
  }
});

async function handleGuestQuoteSubmission(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const context = await loadGuestContext(client, req.params.token, { forUpdate: true });
    if (!context) throw fail(404, "GUEST_TOKEN_INVALID_OR_EXPIRED");
    const rfq = await loadRfq(client, context.rfq_id, context.company_id, context.vendor_id || context.invited_vendor_id);
    const rawLines = parseJsonField(req.body?.lines, "INVALID_QUOTE_LINES");
    const lines = await resolvePortalQuoteLines(client, rfq, rawLines, context.vendor_id || context.invited_vendor_id);
    const metadata = parseJsonField(req.body?.documents_metadata, "INVALID_DOCUMENT_METADATA");
    const documents = await saveDocuments(client, req.files, metadata, {
      vendorId: context.vendor_id || context.invited_vendor_id,
      guestTokenId: context.id,
      vendorEmail: context.vendor_email,
      vendorName: context.vendor_name || context.vendor_code,
    });
    const quoteId = await savePortalQuote(client, {
      rfq,
      invitation: rfq.invitation,
      vendorId: context.vendor_id || context.invited_vendor_id,
      guestTokenId: context.id,
      receivedVia: "guest_portal",
      verificationStatus: "pending_guest_verification",
      body: req.body || {},
      lines,
    });
    await client.query(`update guest_rfq_tokens set is_used = true, used_at = now() where id = $1`, [Number(context.id)]);
    await client.query("commit");
    return res.status(201).json({
      ok: true,
      quote_id: quoteId,
      documents,
      status: "Pending Guest Verification",
      submission_status: "pending_guest_verification",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
}

router.post("/guest/:token/quote", upload.array("documents", 6), handleGuestQuoteSubmission);
router.post("/guest/:token", upload.array("documents", 6), handleGuestQuoteSubmission);

router.get("/admin/vendors", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select vu.id, vu.email, vu.status, vu.last_login_at,
               v.id as vendor_id, v.vendor_code, v.company_name,
               count(vd.id)::int as document_count,
               count(vd.id) filter (where vd.expiry_date < current_date)::int as expired_document_count
        from vendor_users vu
        join vendors v on v.id = vu.vendor_id and v.company_id = $1
        left join vendor_documents vd on vd.vendor_id = v.id
        group by vu.id, v.id
        order by vu.status asc, v.company_name asc, vu.email asc
      `,
      [companyId]
    );
    return res.json({ ok: true, vendors: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/documents", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select vd.id, vd.document_type, vd.file_name, vd.expiry_date,
               vd.verification_status, vd.verified_at, vd.created_at,
               v.vendor_code, v.company_name, v.id as vendor_id
        from vendor_documents vd
        join vendors v on v.id = vd.vendor_id and v.company_id = $1
        order by vd.expiry_date nulls last, vd.created_at desc
        limit 500
      `,
      [companyId]
    );
    return res.json({ ok: true, documents: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/guest-tokens", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select t.id, t.rfq_id, t.vendor_email, t.expires_at, t.is_used,
               t.created_at, rfq.rfq_number, v.vendor_code, v.company_name
        from guest_rfq_tokens t
        join purchase_rfqs rfq on rfq.id = t.rfq_id and rfq.company_id = $1
        left join vendors v on v.id = t.vendor_id
        order by t.created_at desc
        limit 300
      `,
      [companyId]
    );
    return res.json({ ok: true, tokens: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch("/admin/vendor-users/:id", requireInternalVendorAccess("can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = cleanText(req.body?.status, 20).toLowerCase();
    if (!["pending", "active", "suspended"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_VENDOR_STATUS" });
    const result = await pool.query(
      `
        update vendor_users vu
        set status = $1, updated_at = now()
        from vendors v
        where vu.id = $2 and v.id = vu.vendor_id and v.company_id = $3
        returning vu.id, vu.email, vu.status, vu.vendor_id
      `,
      [status, Number(req.params.id), companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "VENDOR_USER_NOT_FOUND" });
    return res.json({ ok: true, vendor_user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch("/admin/documents/:id", requireInternalVendorAccess("can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = cleanText(req.body?.verification_status, 20).toLowerCase();
    if (!["pending", "approved", "expired"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_DOCUMENT_STATUS" });
    const result = await pool.query(
      `
        update vendor_documents vd
        set verification_status = $1,
            verified_by = case when $1 = 'approved' then $2 else null end,
            verified_at = case when $1 = 'approved' then now() else null end,
            updated_at = now()
        from vendors v
        where vd.id = $3 and v.id = vd.vendor_id and v.company_id = $4
        returning vd.id, vd.document_type, vd.expiry_date, vd.verification_status
      `,
      [status, req.user.id, Number(req.params.id), companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "DOCUMENT_NOT_FOUND" });
    return res.json({ ok: true, document: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/quotes", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          vq.id, vq.quote_number, vq.quote_status, vq.verification_status,
          vq.received_via, vq.submitted_at, vq.delivery_days,
          vq.purchase_rfq_id, rfq.rfq_number,
          v.id as vendor_id, v.vendor_code, v.company_name,
          count(vql.id)::int as line_count,
          round(coalesce(sum((vql.unit_price + vql.freight_per_unit) * vql.qty), 0)::numeric, 2) as quote_total
        from vendor_quotes vq
        join vendors v on v.id = vq.vendor_id
        left join purchase_rfqs rfq on rfq.id = vq.purchase_rfq_id
        left join vendor_quote_lines vql on vql.vendor_quote_id = vq.id
        where vq.company_id = $1
        group by vq.id, rfq.id, v.id
        order by vq.submitted_at desc nulls last, vq.id desc
        limit 300
      `,
      [companyId]
    );
    return res.json({ ok: true, quotes: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/quotes/:id", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const quoteResult = await pool.query(
      `
        select
          vq.*,
          v.vendor_code,
          v.company_name,
          rfq.rfq_number,
          pr.requisition_number
        from vendor_quotes vq
        join vendors v on v.id = vq.vendor_id
        left join purchase_rfqs rfq on rfq.id = vq.purchase_rfq_id
        left join purchase_requisitions pr on pr.id = vq.purchase_requisition_id
        where vq.id = $1 and vq.company_id = $2
        limit 1
      `,
      [Number(req.params.id), companyId]
    );
    const quote = quoteResult.rows[0] || null;
    if (!quote) return res.status(404).json({ ok: false, error: "QUOTE_NOT_FOUND" });
    const lines = await pool.query(
      `
        select
          vql.*,
          cs.spec_code,
          cs.spec_name,
          cs.geometry,
          cs.material,
          cs.pressure_rating,
          a.brand_name,
          a.freight_percentage,
          a.import_duty_percentage,
          a.is_preferred
        from vendor_quote_lines vql
        left join component_specifications cs on cs.id = vql.component_specification_id
        left join component_specification_avl a on a.id = vql.component_specification_avl_id
        where vql.vendor_quote_id = $1
        order by vql.line_no asc
      `,
      [Number(quote.id)]
    );
    return res.json({ ok: true, quote, lines: lines.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch("/admin/quotes/:id/verification", requireInternalVendorAccess("can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = cleanText(req.body?.verification_status, 40).toLowerCase();
    if (!["internal_verified", "rejected"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_QUOTE_VERIFICATION_STATUS" });
    const result = await pool.query(
      `
        update vendor_quotes
        set verification_status = $1,
            verified_by = $2,
            verified_at = now(),
            verification_notes = $3,
            updated_at = now()
        where id = $4 and company_id = $5
        returning id, quote_number, verification_status, verified_at
      `,
      [status, req.user.id, cleanText(req.body?.verification_notes, 1000) || null, Number(req.params.id), companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "QUOTE_NOT_FOUND" });
    return res.json({ ok: true, quote: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/guest-tokens", requireInternalVendorAccess("can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rfqId = Number(req.body?.rfq_id);
    const invitationId = req.body?.purchase_rfq_vendor_id ? Number(req.body.purchase_rfq_vendor_id) : null;
    const requestedVendorId = req.body?.vendor_id ? Number(req.body.vendor_id) : null;
    const expiresHours = Math.min(720, Math.max(1, Number(req.body?.expires_hours) || 72));
    if (!Number.isFinite(rfqId) || rfqId <= 0) return res.status(400).json({ ok: false, error: "INVALID_RFQ" });
    const rfqResult = await pool.query(`select id, rfq_status, company_id from purchase_rfqs where id = $1 and company_id = $2 limit 1`, [rfqId, companyId]);
    const rfq = rfqResult.rows[0];
    if (!rfq || rfq.rfq_status !== "sent") return res.status(409).json({ ok: false, error: "RFQ_NOT_OPEN" });
    let invitation = null;
    if (invitationId) {
      const invitationResult = await pool.query(
        `select rv.id, rv.vendor_id, v.contact_email from purchase_rfq_vendors rv join vendors v on v.id = rv.vendor_id where rv.id = $1 and rv.purchase_rfq_id = $2 limit 1`,
        [invitationId, rfqId]
      );
      invitation = invitationResult.rows[0] || null;
    }
    const vendorId = requestedVendorId || invitation?.vendor_id || null;
    const email = normalizeEmail(req.body?.vendor_email || invitation?.contact_email);
    if (!vendorId || !email) return res.status(400).json({ ok: false, error: "VENDOR_AND_EMAIL_REQUIRED" });
    const vendorResult = await pool.query(
      `select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`,
      [vendorId, companyId]
    );
    if (!vendorResult.rows[0]) return res.status(404).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    if (invitation?.vendor_id && Number(invitation.vendor_id) !== Number(vendorId)) {
      return res.status(400).json({ ok: false, error: "INVITATION_VENDOR_MISMATCH" });
    }
    const rawToken = createGuestToken();
    const result = await pool.query(
      `
        insert into guest_rfq_tokens (
          token_hash, rfq_id, purchase_rfq_vendor_id, vendor_id, vendor_email, expires_at, created_by
        )
        values ($1,$2,$3,$4,$5,now() + ($6::numeric * interval '1 hour'),$7)
        returning id, rfq_id, vendor_id, vendor_email, expires_at
      `,
      [hashGuestToken(rawToken), rfqId, invitation?.id || null, vendorId, email, expiresHours, req.user.id]
    );
    const base = String(process.env.APP_BASE_URL || "https://josh.absstem.com").replace(/\/+$/, "");
    return res.status(201).json({
      ok: true,
      token: result.rows[0],
      guest_url: `${base}/vendor-portal/guest/${rawToken}`,
    });
  } catch (error) {
    return next(error);
  }
});

executiveRouter.post("/initiate", requireInternalVendorAccess("can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const email = normalizeEmail(req.body?.vendor_email || req.body?.email);
    const companyName = cleanText(req.body?.company_name, 180);
    const contactName = cleanText(req.body?.contact_name, 120) || null;
    const contactPhone = cleanText(req.body?.contact_phone || req.body?.phone, 50) || null;
    const requestedCode = cleanText(req.body?.vendor_code, 80);
    const componentSpecificationId = req.body?.component_specification_id ? Number(req.body.component_specification_id) : null;
    const expiresHours = Math.min(720, Math.max(1, Number(req.body?.expires_hours) || 48));
    if (!email || !companyName) return res.status(400).json({ ok: false, error: "VENDOR_NAME_AND_EMAIL_REQUIRED" });

    await client.query("begin");
    const existingResult = await client.query(
      `
        select id, vendor_code, company_name
        from vendors
        where company_id = $1 and lower(contact_email::text) = $2
        limit 1
      `,
      [companyId, email]
    );
    let vendor = existingResult.rows[0] || null;
    if (!vendor) {
      const vendorCode = requestedCode || `VND-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const insertResult = await client.query(
        `
          insert into vendors (
            company_id, vendor_code, company_name, contact_name, contact_email, contact_phone, is_active
          )
          values ($1,$2,$3,$4,$5,$6,true)
          returning id, vendor_code, company_name
        `,
        [companyId, vendorCode, companyName, contactName, email, contactPhone]
      );
      vendor = insertResult.rows[0];
    } else {
      await client.query(
        `
          update vendors
          set company_name = coalesce(nullif($1, ''), company_name),
              contact_name = coalesce($2, contact_name),
              contact_phone = coalesce($3, contact_phone),
              updated_at = now()
          where id = $4
        `,
        [companyName, contactName, contactPhone, Number(vendor.id)]
      );
    }

    if (Number.isFinite(componentSpecificationId) && componentSpecificationId > 0) {
      await client.query(
        `
          insert into component_specification_avl (
            component_specification_id, vendor_id, is_active, created_by
          )
          values ($1, $2, true, $3)
          on conflict (component_specification_id, vendor_id) do update set is_active = true, updated_at = now()
        `,
        [componentSpecificationId, Number(vendor.id), req.user?.id || null]
      );
    }

    const rawToken = createGuestToken();
    const tokenResult = await client.query(
      `
        insert into vendor_onboarding_tokens (
          token_hash, vendor_id, vendor_email, expires_at, created_by
        )
        values ($1,$2,$3,now() + ($4::numeric * interval '1 hour'),$5)
        returning id, vendor_id, vendor_email, expires_at
      `,
      [hashGuestToken(rawToken), Number(vendor.id), email, expiresHours, req.user.id]
    );
    await client.query("commit");

    const base = String(process.env.APP_BASE_URL || "https://josh.absstem.com").replace(/\/+$/, "");
    const onboardingUrl = `${base}/vendor-portal/register/${rawToken}`;
    let emailSent = false;
    let emailError = null;
    if (isMailConfigured()) {
      try {
        await sendMail({
          to: email,
          subject: "Your absstem supplier portal invitation",
          text: `You have been invited to the absstem supplier portal for ${vendor.company_name}. Set your password here: ${onboardingUrl}. This link expires in ${expiresHours} hours.`,
          html: `<p>You have been invited to the absstem supplier portal for <strong>${escapeHtml(vendor.company_name)}</strong>.</p><p><a href="${escapeHtml(onboardingUrl)}">Set up your supplier access</a></p><p>This secure invitation expires in ${expiresHours} hours.</p>`,
        });
        emailSent = true;
      } catch (mailError) {
        emailError = mailError?.code || "EMAIL_SEND_FAILED";
      }
    } else {
      emailError = "SMTP_NOT_CONFIGURED";
    }
    return res.status(201).json({
      ok: true,
      vendor: { ...vendor, id: Number(vendor.id), email },
      onboarding: { ...tokenResult.rows[0], id: Number(tokenResult.rows[0].id), url: onboardingUrl },
      email_sent: emailSent,
      email_error: emailError,
    });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* transaction may already be committed */
    }
    return next(error);
  } finally {
    client.release();
  }
});

executiveRouter.get("/:id/compliance-report", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const vendorResult = await pool.query(
      `
        select id, vendor_code, company_name, contact_name, contact_email, contact_phone, gstin
        from vendors
        where id = $1 and company_id = $2
        limit 1
      `,
      [Number(req.params.id), companyId]
    );
    const vendor = vendorResult.rows[0] || null;
    if (!vendor) return res.status(404).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    const [documentsResult, avlResult] = await Promise.all([
      pool.query(
        `
          select id, document_type, file_name, expiry_date, verification_status
          from vendor_documents
          where vendor_id = $1
          order by expiry_date nulls last, document_type asc
        `,
        [Number(vendor.id)]
      ),
      pool.query(
        `
          select a.id as avl_id, a.is_preferred, cs.spec_code, cs.spec_name
          from component_specification_avl a
          join component_specifications cs on cs.id = a.component_specification_id
          where a.vendor_id = $1 and a.is_active = true
          order by cs.spec_code asc, a.id asc
        `,
        [Number(vendor.id)]
      ),
    ]);
    const report = await generateVendorComplianceReport({
      vendor,
      documents: documentsResult.rows,
      avlApprovals: avlResult.rows,
    });
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="vendor-${String(vendor.vendor_code || vendor.id).replace(/[^a-z0-9_-]+/gi, "-")}-compliance.pdf"`);
    return res.send(report);
  } catch (error) {
    return next(error);
  }
});

executiveRouter.get("/rfqs/:id/comparison-pdf", requireInternalVendorAccess("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rfqResult = await pool.query(
      `
        select rfq.id, rfq.rfq_number, rfq.rfq_status, rfq.due_date, pr.requisition_number
        from purchase_rfqs rfq
        join purchase_requisitions pr on pr.id = rfq.purchase_requisition_id
        where rfq.id = $1 and rfq.company_id = $2
        limit 1
      `,
      [Number(req.params.id), companyId]
    );
    const rfq = rfqResult.rows[0] || null;
    if (!rfq) return res.status(404).json({ ok: false, error: "RFQ_NOT_FOUND" });
    const quotesResult = await pool.query(
      `
        select vq.id, vq.quote_number, vq.verification_status, vq.delivery_days,
               v.company_name,
               round(coalesce(sum((vql.unit_price + vql.freight_per_unit) * vql.qty), 0)::numeric, 2) as quote_total
        from vendor_quotes vq
        join vendors v on v.id = vq.vendor_id
        left join vendor_quote_lines vql on vql.vendor_quote_id = vq.id
        where vq.purchase_rfq_id = $1
          and vq.company_id = $2
          and vq.quote_status <> 'cancelled'
        group by vq.id, v.id
        order by quote_total asc nulls last, v.company_name asc
      `,
      [Number(rfq.id), companyId]
    );
    const report = await generateRfqComparisonReport({ rfq, quotes: quotesResult.rows });
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="rfq-${String(rfq.rfq_number || rfq.id).replace(/[^a-z0-9_-]+/gi, "-")}-comparison.pdf"`);
    return res.send(report);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.executiveRouter = executiveRouter;
