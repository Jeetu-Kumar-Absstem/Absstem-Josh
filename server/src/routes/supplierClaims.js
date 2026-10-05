const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(4));
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function canAccessSupplierClaim(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "supplier_claims")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function canSeedSupplierClaimFromQc(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "supplier_claims")) return true;
  return Number(row.qc_created_by) === Number(req.user.id);
}

async function getQualityControlSeedRow(client, qualityControlId) {
  const r = await client.query(
    `
      select
        qc.id,
        qc.qc_number,
        qc.qc_status,
        qc.company_id,
        qc.created_by as qc_created_by,
        qc.goods_receipt_id,
        gr.grn_number,
        gr.vendor_id,
        v.company_name as vendor_name
      from quality_controls qc
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = gr.vendor_id
      where qc.id = $1
      limit 1
    `,
    [qualityControlId]
  );
  return r.rows[0] || null;
}

async function getSupplierClaimHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        sc.*,
        qc.qc_number,
        gr.grn_number,
        v.company_name as vendor_name,
        cu.full_name as created_by_name,
        coalesce(sum(scl.qty_claimed), 0) as total_claimed_qty,
        coalesce(sum(scl.qty_received), 0) as total_received_qty,
        coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as total_pending_qty
      from supplier_claims sc
      join quality_controls qc on qc.id = sc.quality_control_id
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = sc.vendor_id
      left join erp_users cu on cu.id = sc.created_by
      left join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
      where sc.id = $1 and sc.company_id = $2
      group by sc.id, qc.qc_number, gr.grn_number, v.company_name, cu.full_name
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getSupplierClaimLines(client, id) {
  const r = await client.query(
    `
      select
        scl.*,
        qha.action_date as source_action_date,
        qha.reference_no as source_reference_no,
        qha.expected_date as source_expected_date,
        qha.remarks as source_action_remarks,
        qcl.hold_reason,
        greatest(scl.qty_claimed - scl.qty_received, 0) as qty_pending
      from supplier_claim_lines scl
      join quality_hold_actions qha on qha.id = scl.quality_hold_action_id
      join quality_control_lines qcl on qcl.id = scl.quality_control_line_id
      where scl.supplier_claim_id = $1
      order by scl.line_no asc
    `,
    [id]
  );
  return r.rows;
}

async function getSupplierClaimReceipts(client, id) {
  const r = await client.query(
    `
      select
        scr.id,
        scr.supplier_claim_id,
        scr.supplier_claim_line_id,
        scr.receipt_number,
        scr.receipt_date,
        scr.qty_received,
        scr.reference_no,
        scr.remarks,
        scr.created_at,
        scl.line_no,
        scl.item_code,
        scl.item_name,
        scl.line_description,
        scl.serial_no_required,
        u.full_name as created_by_name,
        coalesce(
          array_remove(array_agg(scrs.serial_no order by scrs.serial_no), null),
          '{}'
        ) as serials
      from supplier_claim_receipts scr
      join supplier_claim_lines scl on scl.id = scr.supplier_claim_line_id
      left join supplier_claim_receipt_serials scrs on scrs.supplier_claim_receipt_id = scr.id
      left join erp_users u on u.id = scr.created_by
      where scr.supplier_claim_id = $1
      group by
        scr.id,
        scr.supplier_claim_id,
        scr.supplier_claim_line_id,
        scr.receipt_number,
        scr.receipt_date,
        scr.qty_received,
        scr.reference_no,
        scr.remarks,
        scr.created_at,
        scl.line_no,
        scl.item_code,
        scl.item_name,
        scl.line_description,
        scl.serial_no_required,
        u.full_name
      order by scr.receipt_date desc, scr.id desc
    `,
    [id]
  );
  return r.rows.map((row) => ({
    ...row,
    serials: Array.isArray(row.serials) ? row.serials.filter(Boolean) : [],
  }));
}

async function getClaimableQualityControls(client, req, companyId) {
  const params = [];
  const where = [
    `qc.qc_status = 'closed'`,
    `qha.action_type = 'supplier_replacement'`,
    `scl.id is null`,
  ];
  params.push(Number(companyId));
  where.push(`qc.company_id = $${params.length}`);

  if (ownRecordsOnly(req, "supplier_claims")) {
    params.push(Number(req.user.id));
    where.push(`qc.created_by = $${params.length}`);
  }

  const r = await client.query(
    `
      select
        qc.id,
        qc.qc_number,
        gr.grn_number,
        v.company_name as vendor_name,
        count(*) as pending_action_count,
        coalesce(sum(qha.qty), 0) as qty_claimable
      from quality_hold_actions qha
      join quality_controls qc on qc.id = qha.quality_control_id
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = gr.vendor_id
      left join supplier_claim_lines scl on scl.quality_hold_action_id = qha.id
      where ${where.join(" and ")}
      group by qc.id, qc.qc_number, gr.grn_number, v.company_name
      order by qc.id desc
    `,
    params
  );
  return r.rows;
}

async function syncSupplierClaimStatus(client, supplierClaimId, preferredStatus = null) {
  const totalsRes = await client.query(
    `
      select
        coalesce(sum(greatest(qty_claimed - qty_received, 0)), 0) as total_pending_qty
      from supplier_claim_lines
      where supplier_claim_id = $1
    `,
    [supplierClaimId]
  );
  const pending = money(totalsRes.rows[0]?.total_pending_qty);

  let nextStatus = preferredStatus;
  if (!nextStatus) nextStatus = pending <= 0 ? "closed" : "open";

  if (nextStatus === "closed" && pending > 0) {
    const err = new Error("Claim still has pending replacement qty");
    err.code = "CLAIM_PENDING_RECEIPT";
    throw err;
  }

  await client.query(
    `
      update supplier_claims
      set claim_status = $2,
          updated_at = now()
      where id = $1
    `,
    [supplierClaimId, nextStatus]
  );
}

router.get("/bootstrap", requireScreenAction("supplier_claims", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const claimable = await getClaimableQualityControls(pool, req, companyId);
    return res.json({ ok: true, claimable_quality_controls: claimable });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("supplier_claims", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const filters = [];
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    filters.push(`sc.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "supplier_claims")) {
      params.push(Number(req.user.id));
      filters.push(`sc.created_by = $${params.length}`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";

    const r = await pool.query(
      `
        select
          sc.id,
          sc.claim_number,
          sc.claim_status,
          sc.claim_date,
          sc.quality_control_id,
          qc.qc_number,
          gr.grn_number,
          v.company_name as vendor_name,
          coalesce(sum(scl.qty_claimed), 0) as total_claimed_qty,
          coalesce(sum(scl.qty_received), 0) as total_received_qty,
          coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as total_pending_qty
        from supplier_claims sc
        join quality_controls qc on qc.id = sc.quality_control_id
        join goods_receipts gr on gr.id = qc.goods_receipt_id
        join vendors v on v.id = sc.vendor_id
        left join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
        ${where}
        group by sc.id, qc.qc_number, gr.grn_number, v.company_name
        order by sc.created_at desc, sc.id desc
      `,
      params
    );
    return res.json({ ok: true, supplier_claims: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-quality-control/:id", requireScreenAction("supplier_claims", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const qualityControlId = Number(req.params.id);
    if (!Number.isFinite(qualityControlId) || qualityControlId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_QC" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const qc = await getQualityControlSeedRow(client, qualityControlId);
    if (!qc) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "QC_NOT_FOUND" });
    }
    if (Number(qc.company_id) !== Number(companyId) || !canAccessCompanyContext(req, qc)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canSeedSupplierClaimFromQc(req, qc)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(qc.qc_status || "").toLowerCase() !== "closed") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QC_NOT_CLOSED" });
    }

    const actionsRes = await client.query(
      `
        select
          qha.id as quality_hold_action_id,
          qha.qty,
          qha.remarks as action_remarks,
          qha.reference_no,
          qha.expected_date,
          qcl.id as quality_control_line_id,
          qcl.line_no,
          qcl.product_id,
          qcl.item_code,
          qcl.item_name,
          qcl.line_description,
          qcl.uom,
          coalesce(p.serial_no_required, false) as serial_no_required
        from quality_hold_actions qha
        join quality_control_lines qcl on qcl.id = qha.quality_control_line_id
        left join products p on p.id = qcl.product_id
        left join supplier_claim_lines scl on scl.quality_hold_action_id = qha.id
        where qha.quality_control_id = $1
          and qha.action_type = 'supplier_replacement'
          and scl.id is null
        order by qcl.line_no asc, qha.id asc
      `,
      [qualityControlId]
    );
    const claimableActions = actionsRes.rows;
    if (!claimableActions.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_PENDING_CLAIMABLE_REPLACEMENTS" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'SCL') as claim_number`, [companyId]);
    const claimNumber = numRes.rows[0]?.claim_number;
    const insertHeader = await client.query(
      `
        insert into supplier_claims (
          company_id,
          claim_number,
          quality_control_id,
          vendor_id,
          claim_status,
          claim_date,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'open',current_date,$5,$6)
        returning id
      `,
      [
        companyId,
        claimNumber,
        qualityControlId,
        qc.vendor_id,
        `Created from QC ${qc.qc_number}`,
        req.user.id,
      ]
    );
    const supplierClaimId = insertHeader.rows[0]?.id;

    let lineNo = 1;
    for (const row of claimableActions) {
      await client.query(
        `
          insert into supplier_claim_lines (
            supplier_claim_id,
            quality_hold_action_id,
            quality_control_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            uom,
            serial_no_required,
            qty_claimed,
            qty_received,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12)
        `,
        [
          supplierClaimId,
          row.quality_hold_action_id,
          row.quality_control_line_id,
          lineNo,
          row.product_id || null,
          row.item_code || null,
          row.item_name || null,
          row.line_description || null,
          row.uom || null,
          row.serial_no_required === true,
          money(row.qty),
          row.action_remarks || null,
        ]
      );
      lineNo += 1;
    }

    await client.query("commit");
    const header = await getSupplierClaimHeaderOrNull(client, supplierClaimId, companyId);
    const lines = await getSupplierClaimLines(client, supplierClaimId);
    const receipts = await getSupplierClaimReceipts(client, supplierClaimId);
    return res.status(201).json({ ok: true, supplier_claim: header, lines, receipts });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("supplier_claims", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getSupplierClaimHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessSupplierClaim(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getSupplierClaimLines(pool, id);
    const receipts = await getSupplierClaimReceipts(pool, id);
    return res.json({ ok: true, supplier_claim: header, lines, receipts });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("supplier_claims", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const claimStatus = typeof body.claim_status === "string" ? body.claim_status.trim().toLowerCase() : "open";
    if (!["open", "closed", "cancelled"].includes(claimStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    await client.query("begin");
    const header = await getSupplierClaimHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessSupplierClaim(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    await client.query(
      `
        update supplier_claims
        set claim_date = coalesce($2, claim_date),
            remarks = $3,
            updated_at = now()
        where id = $1
      `,
      [id, body.claim_date || null, normalizeText(body.remarks) ?? header.remarks ?? null]
    );

    await syncSupplierClaimStatus(client, id, claimStatus);

    await client.query("commit");
    const nextHeader = await getSupplierClaimHeaderOrNull(client, id, companyId);
    const lines = await getSupplierClaimLines(client, id);
    const receipts = await getSupplierClaimReceipts(client, id);
    return res.json({ ok: true, supplier_claim: nextHeader, lines, receipts });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "CLAIM_PENDING_RECEIPT") {
      return res.status(409).json({ ok: false, error: "CLAIM_PENDING_RECEIPT" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/receipts", requireScreenAction("supplier_claims", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.supplier_claim_line_id || body.line_id);
    const receivedQty = money(body.qty_received || body.qty);
    const serials = Array.isArray(body.serials) ? body.serials : [];

    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (receivedQty <= 0) return res.status(400).json({ ok: false, error: "INVALID_RECEIPT_QTY" });

    await client.query("begin");
    const header = await getSupplierClaimHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessSupplierClaim(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(header.claim_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "CLAIM_CANCELLED" });
    }
    if (String(header.claim_status || "").toLowerCase() === "closed") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "CLAIM_CLOSED" });
    }

    const lines = await getSupplierClaimLines(client, id);
    const line = lines.find((row) => Number(row.id) === lineId);
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }

    const pendingQty = money(line.qty_pending);
    if (receivedQty > pendingQty) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "RECEIPT_EXCEEDS_PENDING" });
    }

    const needsSerials = line.serial_no_required === true;
    if (needsSerials) {
      if (!isIntLike(receivedQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_QTY_NOT_INTEGER" });
      }
      if (serials.length !== Number(receivedQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_COUNT_MISMATCH" });
      }
    }

    const cleanedSerials = serials
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (new Set(cleanedSerials).size !== cleanedSerials.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DUPLICATE_SERIALS" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'SRC') as receipt_number`, [companyId]);
    const receiptNumber = numRes.rows[0]?.receipt_number;
    const insertReceipt = await client.query(
      `
        insert into supplier_claim_receipts (
          supplier_claim_id,
          supplier_claim_line_id,
          company_id,
          receipt_number,
          receipt_date,
          qty_received,
          reference_no,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,coalesce($5, current_date),$6,$7,$8,$9)
        returning id
      `,
      [
        id,
        lineId,
        companyId,
        receiptNumber,
        body.receipt_date || null,
        receivedQty,
        normalizeText(body.reference_no),
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const supplierClaimReceiptId = insertReceipt.rows[0]?.id;

    for (const serialNo of cleanedSerials) {
      await client.query(
        `
          insert into supplier_claim_receipt_serials (
            supplier_claim_receipt_id,
            serial_no
          )
          values ($1,$2)
        `,
        [supplierClaimReceiptId, serialNo]
      );
    }

    await client.query(
      `
        update supplier_claim_lines
        set qty_received = qty_received + $2,
            updated_at = now()
        where id = $1 and supplier_claim_id = $3
      `,
      [lineId, receivedQty, id]
    );

    await syncSupplierClaimStatus(client, id);

    await client.query("commit");
    const nextHeader = await getSupplierClaimHeaderOrNull(client, id, companyId);
    const nextLines = await getSupplierClaimLines(client, id);
    const receipts = await getSupplierClaimReceipts(client, id);
    return res.status(201).json({
      ok: true,
      supplier_claim: nextHeader,
      lines: nextLines,
      receipts,
      receipt_number: receiptNumber,
    });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, error: "DUPLICATE_SERIALS" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
