const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { notifyGrnShortClosed } = require("../services/notifications");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ageDays(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

async function loadPoMatchBundle(client, purchaseOrderId) {
  const headerRes = await client.query(
    `
      select
        po.*,
        v.company_name as vendor_name
      from purchase_orders po
      join vendors v on v.id = po.vendor_id
      where po.id = $1
      limit 1
    `,
    [purchaseOrderId]
  );
  const purchaseOrder = headerRes.rows[0] || null;
  if (!purchaseOrder) return null;

  const linesRes = await client.query(
    `
      select
        pol.id,
        pol.line_no,
        pol.product_id,
        pol.item_code,
        pol.item_name,
        pol.line_description,
        pol.uom,
        pol.qty as qty_ordered
      from purchase_order_lines pol
      where pol.purchase_order_id = $1
      order by pol.line_no asc
    `,
    [purchaseOrderId]
  );

  const grnPostedRes = await client.query(
    `
      select
        grl.purchase_order_line_id,
        coalesce(sum(grl.qty_received), 0) as qty_received_posted
      from goods_receipt_lines grl
      join goods_receipts gr on gr.id = grl.goods_receipt_id
      where gr.purchase_order_id = $1
        and gr.receipt_status = 'posted'
        and grl.purchase_order_line_id is not null
      group by grl.purchase_order_line_id
    `,
    [purchaseOrderId]
  );
  const grnDraftRes = await client.query(
    `
      select
        grl.purchase_order_line_id,
        coalesce(sum(grl.qty_received), 0) as qty_received_draft
      from goods_receipt_lines grl
      join goods_receipts gr on gr.id = grl.goods_receipt_id
      where gr.purchase_order_id = $1
        and gr.receipt_status in ('draft', 'submitted', 'approved')
        and grl.purchase_order_line_id is not null
      group by grl.purchase_order_line_id
    `,
    [purchaseOrderId]
  );

  const invPostedRes = await client.query(
    `
      select
        pil.purchase_order_line_id,
        coalesce(sum(pil.qty), 0) as qty_invoiced_posted
      from purchase_invoice_lines pil
      join purchase_invoices pi on pi.id = pil.purchase_invoice_id
      where pi.purchase_order_id = $1
        and pi.invoice_status = 'posted'
        and pil.purchase_order_line_id is not null
      group by pil.purchase_order_line_id
    `,
    [purchaseOrderId]
  );
  const invDraftRes = await client.query(
    `
      select
        pil.purchase_order_line_id,
        coalesce(sum(pil.qty), 0) as qty_invoiced_draft
      from purchase_invoice_lines pil
      join purchase_invoices pi on pi.id = pil.purchase_invoice_id
      where pi.purchase_order_id = $1
        and pi.invoice_status in ('draft', 'submitted', 'approved')
        and pil.purchase_order_line_id is not null
      group by pil.purchase_order_line_id
    `,
    [purchaseOrderId]
  );

  const receivedPostedMap = new Map(grnPostedRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_received_posted)]));
  const receivedDraftMap = new Map(grnDraftRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_received_draft)]));
  const invoicedPostedMap = new Map(invPostedRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_invoiced_posted)]));
  const invoicedDraftMap = new Map(invDraftRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_invoiced_draft)]));

  const lines = (linesRes.rows || []).map((line) => {
    const ordered = qty(line.qty_ordered);
    const receivedPosted = qty(receivedPostedMap.get(Number(line.id)));
    const receivedDraft = qty(receivedDraftMap.get(Number(line.id)));
    const invoicedPosted = qty(invoicedPostedMap.get(Number(line.id)));
    const invoicedDraft = qty(invoicedDraftMap.get(Number(line.id)));
    const pendingReceive = Math.max(ordered - receivedPosted, 0);
    const pendingInvoice = Math.max(receivedPosted - invoicedPosted, 0);

    return {
      ...line,
      qty_ordered: ordered,
      qty_received_posted: receivedPosted,
      qty_received_draft: receivedDraft,
      qty_invoiced_posted: invoicedPosted,
      qty_invoiced_draft: invoicedDraft,
      qty_pending_receive: pendingReceive,
      qty_pending_invoice: pendingInvoice,
      is_qty_mismatch: receivedPosted > ordered || invoicedPosted > receivedPosted,
    };
  });

  const summary = lines.reduce(
    (acc, line) => {
      acc.ordered += qty(line.qty_ordered);
      acc.received_posted += qty(line.qty_received_posted);
      acc.received_draft += qty(line.qty_received_draft);
      acc.invoiced_posted += qty(line.qty_invoiced_posted);
      acc.invoiced_draft += qty(line.qty_invoiced_draft);
      acc.pending_receive += qty(line.qty_pending_receive);
      if (line.is_qty_mismatch) acc.mismatch_lines += 1;
      return acc;
    },
    {
      ordered: 0,
      received_posted: 0,
      received_draft: 0,
      invoiced_posted: 0,
      invoiced_draft: 0,
      pending_receive: 0,
      mismatch_lines: 0,
    }
  );

  const poStatus = String(purchaseOrder.po_status || "").toLowerCase();
  const shortClosed = Boolean(purchaseOrder.receipt_short_closed_at);
  const canShortClose =
    !shortClosed &&
    ["approved", "closed"].includes(poStatus) &&
    summary.pending_receive > 0.0001 &&
    summary.received_posted > 0.0001;

  return {
    purchase_order: purchaseOrder,
    summary,
    lines,
    flags: {
      has_mismatch: summary.mismatch_lines > 0,
      can_short_close: canShortClose,
      short_closed: shortClosed,
      age_days: ageDays(purchaseOrder.po_date || purchaseOrder.created_at),
      pending_receive: summary.pending_receive,
    },
  };
}

router.get("/bootstrap", requireScreenAction("three_way_match", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const params = [];
    const where = [`po.po_status <> 'cancelled'`];
    if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
      params.push(Number(companyId));
      where.push(`po.company_id = $${params.length}`);
    }
    const r = await pool.query(
      `
        select
          po.id,
          po.po_number,
          po.po_status,
          po.po_date,
          po.receipt_short_closed_at,
          v.company_name as vendor_name
        from purchase_orders po
        join vendors v on v.id = po.vendor_id
        where ${where.join(" and ")}
        order by po.created_at desc, po.id desc
        limit 500
      `,
      params
    );
    return res.json({ ok: true, purchase_orders: r.rows });
  } catch (err) {
    return next(err);
  }
});

const EXCEPTION_BUCKETS = new Set(["all", "mismatch", "over_invoiced", "over_received", "short_close", "aging", "short_closed"]);
const AGE_BANDS = new Set(["all", "0_7", "8_30", "31_plus"]);

function ageBand(days) {
  const d = Number(days || 0);
  if (d <= 7) return "0_7";
  if (d <= 30) return "8_30";
  return "31_plus";
}

function exceptionAction(row) {
  if (row.over_invoiced_lines > 0 && row.draft_grn_qty > 0) {
    return { key: "post_draft_grn", label: "Post the draft GRN", reason: "Invoice is ahead of posted receipts — a draft GRN is waiting to be posted." };
  }
  if (row.over_invoiced_lines > 0) {
    return { key: "hold_invoice", label: "Hold invoice / raise debit note", reason: "Vendor invoiced more than was received — hold payment or raise a debit note." };
  }
  if (row.over_received_lines > 0) {
    return { key: "return_or_amend", label: "Return excess or amend PO", reason: "More received than ordered — return the excess or amend the PO quantity." };
  }
  if (row.can_short_close) {
    return { key: "short_close", label: "Short-close remaining", reason: "Partial receipt has stalled — short-close the balance if the vendor will not supply it." };
  }
  return { key: "none", label: "Review", reason: "Receipt already short-closed." };
}

router.get("/exceptions", requireScreenAction("three_way_match", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const bucket = EXCEPTION_BUCKETS.has(String(req.query.bucket || "all").trim().toLowerCase())
      ? String(req.query.bucket || "all").trim().toLowerCase()
      : "all";
    const band = AGE_BANDS.has(String(req.query.age_band || "all").trim().toLowerCase())
      ? String(req.query.age_band || "all").trim().toLowerCase()
      : "all";
    const params = [];
    const where = [`po.po_status <> 'cancelled'`];
    if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
      params.push(Number(companyId));
      where.push(`po.company_id = $${params.length}`);
    }

    const r = await pool.query(
      `
        with scoped_po as (
          select po.id, po.po_number, po.po_status, po.po_date, po.created_at, po.receipt_short_closed_at, v.company_name as vendor_name
          from purchase_orders po
          join vendors v on v.id = po.vendor_id
          where ${where.join(" and ")}
        ),
        grn as (
          select grl.purchase_order_line_id as line_id,
            coalesce(sum(grl.qty_received) filter (where gr.receipt_status = 'posted'), 0) as rec_posted,
            coalesce(sum(grl.qty_received) filter (where gr.receipt_status in ('draft', 'submitted', 'approved')), 0) as rec_draft,
            max(gr.receipt_date) filter (where gr.receipt_status = 'posted') as last_grn
          from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          join scoped_po sp on sp.id = gr.purchase_order_id
          where grl.purchase_order_line_id is not null
          group by grl.purchase_order_line_id
        ),
        inv as (
          select pil.purchase_order_line_id as line_id,
            coalesce(sum(pil.qty) filter (where pi.invoice_status = 'posted'), 0) as inv_posted,
            max(pi.invoice_date) filter (where pi.invoice_status = 'posted') as last_inv
          from purchase_invoice_lines pil
          join purchase_invoices pi on pi.id = pil.purchase_invoice_id
          join scoped_po sp on sp.id = pi.purchase_order_id
          where pil.purchase_order_line_id is not null
          group by pil.purchase_order_line_id
        ),
        lines as (
          select pol.purchase_order_id,
            coalesce(pol.qty, 0) as ordered,
            coalesce(g.rec_posted, 0) as rec_posted,
            coalesce(g.rec_draft, 0) as rec_draft,
            coalesce(i.inv_posted, 0) as inv_posted,
            g.last_grn,
            i.last_inv
          from purchase_order_lines pol
          join scoped_po sp on sp.id = pol.purchase_order_id
          left join grn g on g.line_id = pol.id
          left join inv i on i.line_id = pol.id
        ),
        agg as (
          select purchase_order_id,
            sum(greatest(ordered - rec_posted, 0)) as pending_receive,
            sum(rec_posted) as received_posted,
            sum(rec_draft) as draft_grn_qty,
            sum(inv_posted) as invoiced_posted,
            count(*) filter (where rec_posted > ordered + 0.0001)::int as over_received_lines,
            count(*) filter (where inv_posted > rec_posted + 0.0001)::int as over_invoiced_lines,
            greatest(max(last_grn), max(last_inv)) as last_activity_at
          from lines
          group by purchase_order_id
        )
        select sp.*, a.pending_receive, a.received_posted, a.draft_grn_qty, a.invoiced_posted,
          a.over_received_lines, a.over_invoiced_lines, a.last_activity_at
        from scoped_po sp
        join agg a on a.purchase_order_id = sp.id
        where a.over_received_lines > 0
           or a.over_invoiced_lines > 0
           or sp.receipt_short_closed_at is not null
           or (sp.receipt_short_closed_at is null and lower(sp.po_status) in ('approved', 'closed')
               and a.pending_receive > 0.0001 and a.received_posted > 0.0001)
      `,
      params
    );

    const all = r.rows.map((row) => {
      const overReceived = Number(row.over_received_lines || 0);
      const overInvoiced = Number(row.over_invoiced_lines || 0);
      const shortClosed = Boolean(row.receipt_short_closed_at);
      const canShortClose =
        !shortClosed &&
        ["approved", "closed"].includes(String(row.po_status || "").toLowerCase()) &&
        qty(row.pending_receive) > 0.0001 &&
        qty(row.received_posted) > 0.0001;
      const stalledDays = ageDays(row.last_activity_at || row.po_date || row.created_at);
      const base = {
        purchase_order_id: Number(row.id),
        po_number: row.po_number,
        vendor_name: row.vendor_name,
        po_status: row.po_status,
        po_date: row.po_date,
        age_days: ageDays(row.po_date || row.created_at),
        stalled_days: stalledDays,
        age_band: ageBand(stalledDays),
        last_activity_at: row.last_activity_at,
        mismatch_lines: overReceived + overInvoiced,
        over_received_lines: overReceived,
        over_invoiced_lines: overInvoiced,
        draft_grn_qty: qty(row.draft_grn_qty),
        pending_receive: qty(row.pending_receive),
        received_posted: qty(row.received_posted),
        invoiced_posted: qty(row.invoiced_posted),
        can_short_close: canShortClose,
        short_closed: shortClosed,
      };
      const action = exceptionAction(base);
      return { ...base, recommended_action: action.key, recommended_action_label: action.label, queue_reason: action.reason };
    });

    const open = all.filter((row) => row.mismatch_lines > 0 || row.can_short_close);
    const inBucket = (row, key) => {
      if (key === "mismatch") return row.mismatch_lines > 0;
      if (key === "over_invoiced") return row.over_invoiced_lines > 0;
      if (key === "over_received") return row.over_received_lines > 0;
      if (key === "short_close") return row.can_short_close;
      if (key === "aging") return (row.mismatch_lines > 0 || row.can_short_close) && Number(row.stalled_days || 0) > 7;
      if (key === "short_closed") return row.short_closed;
      return row.mismatch_lines > 0 || row.can_short_close;
    };

    const counts = {};
    for (const key of EXCEPTION_BUCKETS) counts[key] = all.filter((row) => inBucket(row, key)).length;
    const age_bands = { "0_7": 0, "8_30": 0, "31_plus": 0 };
    for (const row of open) age_bands[row.age_band] += 1;

    const exceptions = all
      .filter((row) => inBucket(row, bucket))
      .filter((row) => band === "all" || row.age_band === band)
      .sort((a, b) => {
        const mismatchDelta = Number(b.mismatch_lines || 0) - Number(a.mismatch_lines || 0);
        if (mismatchDelta) return mismatchDelta;
        return Number(b.stalled_days || 0) - Number(a.stalled_days || 0);
      });

    return res.json({
      ok: true,
      bucket,
      age_band: band,
      count: exceptions.length,
      counts,
      age_bands,
      exceptions: exceptions.slice(0, 200),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/po/:id", requireScreenAction("three_way_match", "can_view"), async (req, res, next) => {
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId)) return res.status(400).json({ ok: false, error: "INVALID_PO" });

    const bundle = await loadPoMatchBundle(pool, purchaseOrderId);
    if (!bundle) return res.status(404).json({ ok: false, error: "PO_NOT_FOUND" });
    const companyId = requireResolvedCompanyId(req);
    if (Number(companyId) > 0 && bundle.purchase_order.company_id != null && Number(bundle.purchase_order.company_id) !== Number(companyId)) {
      return res.status(404).json({ ok: false, error: "PO_NOT_FOUND" });
    }

    return res.json({
      ok: true,
      purchase_order: bundle.purchase_order,
      summary: bundle.summary,
      lines: bundle.lines,
      flags: bundle.flags,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/po/:id/short-close", requireScreenAction("three_way_match", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId)) return res.status(400).json({ ok: false, error: "INVALID_PO" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) : "";

    await client.query("begin");
    const poLock = await client.query(
      `
        select *
        from purchase_orders
        where id = $1 and company_id = $2
        limit 1
        for update
      `,
      [purchaseOrderId, companyId]
    );
    const po = poLock.rows[0] || null;
    if (!po) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "PO_NOT_FOUND" });
    }

    const poStatus = String(po.po_status || "").toLowerCase();
    if (!["approved", "closed"].includes(poStatus)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PO_NOT_RECEIVABLE" });
    }
    if (po.receipt_short_closed_at) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ALREADY_SHORT_CLOSED" });
    }

    const bundle = await loadPoMatchBundle(client, purchaseOrderId);
    const pendingQty = qty(bundle?.summary?.pending_receive);
    if (pendingQty <= 0.0001) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOTHING_TO_SHORT_CLOSE" });
    }

    await client.query(
      `
        update purchase_orders
        set receipt_short_closed_at = now(),
            receipt_short_closed_by = $2,
            receipt_short_close_remarks = $3,
            po_status = case when po_status = 'approved' then 'closed' else po_status end,
            updated_at = now()
        where id = $1 and company_id = $4
      `,
      [purchaseOrderId, req.user.id, remarks || null, companyId]
    );

    await client.query("commit");

    const nextBundle = await loadPoMatchBundle(pool, purchaseOrderId);
    notifyGrnShortClosed({
      purchaseOrderId,
      poNumber: nextBundle?.purchase_order?.po_number || po.po_number,
      vendorName: nextBundle?.purchase_order?.vendor_name || null,
      companyId,
      actorUserId: req.user.id,
      createdByUserId: po.created_by || null,
      pendingQtyClosed: pendingQty,
    }).catch(() => {});

    return res.json({
      ok: true,
      purchase_order: nextBundle?.purchase_order || null,
      summary: nextBundle?.summary || null,
      lines: nextBundle?.lines || [],
      flags: nextBundle?.flags || null,
      pending_qty_closed: pendingQty,
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
