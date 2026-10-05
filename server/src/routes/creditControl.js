const express = require("express");

const { hasScreenAction } = require("../auth/authorization");
const { pool } = require("../db/pool");
const { getActiveCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { getCustomerCreditSnapshot, getCreditControlDecision, isCreditControlReady } = require("../services/creditControl");
const { buildCustomerCompanyScopeSql, getSingleActiveCustomerCompanyId } = require("../services/customerCompanyAccess");

const router = express.Router();

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(2));
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function canViewCreditControl(req) {
  return (
    hasScreenAction(req, "sales_orders", "can_view") ||
    hasScreenAction(req, "dispatches", "can_view") ||
    hasScreenAction(req, "invoices", "can_view") ||
    hasScreenAction(req, "receipts", "can_view") ||
    hasScreenAction(req, "ar_desk", "can_view") ||
    hasScreenAction(req, "customers", "can_view")
  );
}

function canManageCreditProfile(req) {
  return hasScreenAction(req, "customers", "can_edit") || hasScreenAction(req, "customers", "can_create");
}

function canManageCreditRelease(req) {
  return (
    hasScreenAction(req, "receipts", "can_edit") ||
    hasScreenAction(req, "invoices", "can_edit") ||
    hasScreenAction(req, "sales_orders", "can_edit") ||
    hasScreenAction(req, "dispatches", "can_edit") ||
    canManageCreditProfile(req)
  );
}

function canApproveCreditRelease(req) {
  return (
    hasScreenAction(req, "receipts", "can_approve") ||
    hasScreenAction(req, "invoices", "can_approve") ||
    hasScreenAction(req, "ar_desk", "can_approve") ||
    canManageCreditProfile(req)
  );
}

function creditReleasePermissions(req) {
  return {
    can_request: canManageCreditRelease(req),
    can_approve: canApproveCreditRelease(req),
    user_id: Number(req.user.id),
    self_approval_allowed: req.user.group_name === "SuperAdmin",
  };
}

async function loadContextFilters(req, client = pool) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
  if (isDistributor && !distributorId) return { ok: false, error: "DISTRIBUTOR_NOT_LINKED" };
  const activeCompanyId = isDistributor ? null : getActiveCompanyId(req) || null;
  if (!isDistributor && !activeCompanyId) return { ok: false, error: "COMPANY_NOT_SELECTED" };
  return { ok: true, isDistributor, distributorId, activeCompanyId };
}

function matchesBucket(snapshot, bucket) {
  if (!bucket || bucket === "all") return true;
  if (!snapshot?.ready) return false;
  const latestStatus = String(snapshot.latest_release?.release_status || "").toLowerCase();
  switch (bucket) {
    case "hold":
      return Boolean(snapshot.profile?.is_credit_hold);
    case "over_limit":
      return Boolean(snapshot.evaluation?.over_limit);
    case "overdue":
      return Number(snapshot.exposure?.overdue_count || 0) > 0;
    case "release_requested":
      return latestStatus === "requested";
    case "dispatch_blocked":
      return Boolean(getCreditControlDecision(snapshot, "dispatch_release")?.block);
    case "active_release":
      return Boolean(snapshot.active_release?.id);
    default:
      return true;
  }
}

function sortPriority(snapshot) {
  if (snapshot.profile?.is_credit_hold) return 0;
  if (String(snapshot.latest_release?.release_status || "").toLowerCase() === "requested") return 1;
  if (snapshot.evaluation?.limit_blocked) return 2;
  if (snapshot.evaluation?.overdue_blocked) return 3;
  if (snapshot.active_release?.id) return 4;
  return 5;
}

function buildCreditQueueMetadata(snapshot) {
  if (!snapshot?.ready) {
    return {
      queue_reason: "Credit control is not ready for this customer yet.",
      recommended_action: "review_customer",
      recommended_action_label: "Review customer",
      attention_level: "low",
    };
  }

  const latestStatus = String(snapshot.latest_release?.release_status || "").toLowerCase();
  const dispatchDecision = getCreditControlDecision(snapshot, "dispatch_release");

  if (snapshot.profile?.is_credit_hold) {
    return {
      queue_reason: snapshot.profile?.credit_hold_reason || "Customer is on manual credit hold.",
      recommended_action: "review_hold",
      recommended_action_label: "Review hold",
      attention_level: "high",
    };
  }

  if (latestStatus === "requested") {
    return {
      queue_reason: "Credit release is waiting for approval before the next order or dispatch step.",
      recommended_action: "review_release",
      recommended_action_label: "Review release",
      attention_level: "high",
    };
  }

  if (snapshot.evaluation?.over_limit) {
    return {
      queue_reason: `Customer is over the approved credit limit by ${Number(snapshot.exposure?.over_limit_amount || 0).toFixed(2)}.`,
      recommended_action: snapshot.active_release?.id ? "review_release" : "collect_or_release",
      recommended_action_label: snapshot.active_release?.id ? "Review release" : "Collect or request release",
      attention_level: "high",
    };
  }

  if (snapshot.evaluation?.overdue_blocked) {
    return {
      queue_reason: `Customer has ${Number(snapshot.exposure?.overdue_count || 0)} overdue invoice(s) blocking the next release step.`,
      recommended_action: "follow_up_collection",
      recommended_action_label: "Follow up collections",
      attention_level: "high",
    };
  }

  if (dispatchDecision?.block) {
    return {
      queue_reason: dispatchDecision.message || "Dispatch is blocked by the current credit position.",
      recommended_action: "review_dispatch_block",
      recommended_action_label: "Review dispatch block",
      attention_level: "medium",
    };
  }

  if (snapshot.active_release?.id) {
    return {
      queue_reason: "Approved release cover is active. Review exposure before the expiry date.",
      recommended_action: "monitor_release",
      recommended_action_label: "Monitor release",
      attention_level: "medium",
    };
  }

  return {
    queue_reason: "Customer credit is currently clear.",
    recommended_action: "review_customer",
    recommended_action_label: "Review customer",
    attention_level: "low",
  };
}

async function listCandidateCustomers(client, { companyId = null, distributorId = null, q = "", limit = 250 } = {}) {
  const params = [];
  const where = [];
  const hasDistributorScope = Number.isFinite(Number(distributorId)) && Number(distributorId) > 0;
  const hasCompanyScope = Number.isFinite(Number(companyId)) && Number(companyId) > 0;
  if (!hasDistributorScope && !hasCompanyScope) return [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.customer_name ilike $${params.length} or coalesce(c.customer_code, '') ilike $${params.length})`);
  }

  const scopeInvoice = [];
  const scopeOrder = [];
  const scopeRelease = [];
  if (hasDistributorScope) {
    params.push(Number(distributorId));
    scopeInvoice.push(`ci.distributor_id = $${params.length}`);
    scopeOrder.push(`so.distributor_id = $${params.length}`);
    scopeRelease.push(`r.distributor_id = $${params.length}`);
    where.push(
      `exists (
        select 1
        from customer_distributor_links cdl
        where cdl.customer_id = c.id
          and cdl.distributor_id = $${params.length}
      )`
    );
  } else if (hasCompanyScope) {
    params.push(Number(companyId));
    scopeInvoice.push(`ci.company_id = $${params.length}`);
    scopeOrder.push(`so.company_id = $${params.length}`);
    scopeRelease.push(`r.company_id = $${params.length}`);
    where.push(buildCustomerCompanyScopeSql("c.id", `$${params.length}`));
  }

  const rows = await client.query(
    `
      select
        c.id,
        c.customer_name,
        c.customer_code
      from customers c
      where ${where.length ? `${where.join(" and ")} and` : ""}
        (
          coalesce(c.credit_limit, 0) > 0
          or c.is_credit_hold = true
          or exists (
            select 1
            from customer_invoices ci
            where ci.customer_id = c.id
              and ci.invoice_status <> 'cancelled'
              ${scopeInvoice.length ? `and ${scopeInvoice.join(" and ")}` : ""}
          )
          or exists (
            select 1
            from sales_orders so
            where so.customer_id = c.id
              and so.order_status in ('confirmed', 'closed')
              ${scopeOrder.length ? `and ${scopeOrder.join(" and ")}` : ""}
          )
          or exists (
            select 1
            from customer_credit_releases r
            where r.customer_id = c.id
              ${scopeRelease.length ? `and ${scopeRelease.join(" and ")}` : ""}
          )
        )
      order by c.customer_name asc
      limit ${Math.min(Math.max(Number(limit || 250), 1), 1000)}
    `,
    params
  );
  return rows.rows || [];
}

router.get("/summary", async (req, res, next) => {
  try {
    if (!canViewCreditControl(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCreditControlReady();
    if (!ready) return res.json({ ok: true, summary: { ready: false } });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const candidates = await listCandidateCustomers(pool, {
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
      limit: 1000,
    });
    const snapshots = (await Promise.all(
      candidates.map((row) =>
        getCustomerCreditSnapshot(pool, {
          customerId: row.id,
          companyId: ctx.activeCompanyId,
          distributorId: ctx.distributorId,
        })
      )
    )).filter(Boolean);

    const summary = snapshots.reduce(
      (acc, row) => {
        if (!row?.ready) return acc;
        if (row.profile?.is_credit_hold) acc.credit_hold_count += 1;
        if (row.evaluation?.over_limit) {
          acc.over_limit_count += 1;
          acc.over_limit_amount += Number(row.exposure?.over_limit_amount || 0);
        }
        if (row.evaluation?.overdue_blocked) acc.overdue_blocked_count += 1;
        if (String(row.latest_release?.release_status || "").toLowerCase() === "requested") acc.release_requested_count += 1;
        if (row.active_release?.id) acc.active_release_count += 1;
        if (getCreditControlDecision(row, "dispatch_release")?.block) acc.dispatch_blocked_count += 1;
        return acc;
      },
      {
        ready: true,
        credit_hold_count: 0,
        over_limit_count: 0,
        over_limit_amount: 0,
        overdue_blocked_count: 0,
        release_requested_count: 0,
        active_release_count: 0,
        dispatch_blocked_count: 0,
      }
    );
    summary.over_limit_amount = Number(summary.over_limit_amount.toFixed(2));
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers", async (req, res, next) => {
  try {
    if (!canViewCreditControl(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCreditControlReady();
    if (!ready) return res.json({ ok: true, ready: false, customers: [] });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const q = normalizeText(req.query.q);
    const bucket = normalizeText(req.query.bucket);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const candidates = await listCandidateCustomers(pool, {
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
      q,
      limit: 1000,
    });

    const rows = (await Promise.all(
      candidates.map((row) =>
        getCustomerCreditSnapshot(pool, {
          customerId: row.id,
          companyId: ctx.activeCompanyId,
          distributorId: ctx.distributorId,
        })
      )
    ))
      .filter(Boolean)
      .filter((row) => matchesBucket(row, bucket))
      .sort((a, b) => {
        const priority = sortPriority(a) - sortPriority(b);
        if (priority !== 0) return priority;
        const exposure = Number(b.exposure?.total_exposure || 0) - Number(a.exposure?.total_exposure || 0);
        if (Math.abs(exposure) > 0.0001) return exposure;
        return String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
      })
      .slice(0, limit)
      .map((row) => ({
        ...row,
        decisions: {
          so_confirmation: getCreditControlDecision(row, "so_confirmation"),
          dispatch_release: getCreditControlDecision(row, "dispatch_release"),
        },
        ...buildCreditQueueMetadata(row),
      }));

    return res.json({ ok: true, ready: true, customers: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers/:customerId/snapshot", async (req, res, next) => {
  try {
    if (!canViewCreditControl(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCreditControlReady();
    const customerId = normalizeId(req.params.customerId);
    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    if (!ready) return res.json({ ok: true, ready: false, snapshot: null });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const snapshot = await getCustomerCreditSnapshot(pool, {
      customerId,
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
    });
    if (!snapshot) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    return res.json({
      ok: true,
      ready: true,
      permissions: creditReleasePermissions(req),
      snapshot: {
        ...snapshot,
        decisions: {
          so_confirmation: getCreditControlDecision(snapshot, "so_confirmation"),
          dispatch_release: getCreditControlDecision(snapshot, "dispatch_release"),
        },
        ...buildCreditQueueMetadata(snapshot),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/releases", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!canManageCreditRelease(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCreditControlReady(client);
    if (!ready) return res.status(400).json({ ok: false, error: "CREDIT_CONTROL_NOT_READY" });

    const ctx = await loadContextFilters(req, client);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = normalizeId(body.customer_id);
    const reason = normalizeText(body.reason);
    const remarks = normalizeText(body.remarks);
    const expiresOn = normalizeText(body.expires_on);
    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    if (!reason) return res.status(400).json({ ok: false, error: "INVALID_REASON" });
    if (!expiresOn) return res.status(400).json({ ok: false, error: "INVALID_EXPIRY" });

    const snapshot = await getCustomerCreditSnapshot(client, {
      customerId,
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
    });
    if (!snapshot) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    if (String(snapshot.latest_release?.release_status || "").toLowerCase() === "requested") {
      return res.status(409).json({ ok: false, error: "RELEASE_ALREADY_REQUESTED", release: snapshot.latest_release });
    }
    const releaseCompanyId =
      Number.isFinite(Number(ctx.activeCompanyId)) && Number(ctx.activeCompanyId) > 0
        ? Number(ctx.activeCompanyId)
        : await getSingleActiveCustomerCompanyId(client, customerId);
    if (!releaseCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const r = await client.query(
      `
        insert into customer_credit_releases (
          company_id,
          distributor_id,
          customer_id,
          release_status,
          requested_exposure,
          expires_on,
          reason,
          remarks,
          requested_by
        )
        values ($1,$2,$3,'requested',$4,$5,$6,$7,$8)
        returning *
      `,
      [
        releaseCompanyId,
        ctx.isDistributor ? ctx.distributorId || null : null,
        customerId,
        Number(snapshot.exposure?.total_exposure || 0),
        expiresOn,
        reason,
        remarks || null,
        Number(req.user.id),
      ]
    );
    return res.status(201).json({ ok: true, release: r.rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/releases/:id/status", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!canManageCreditRelease(req) && !canApproveCreditRelease(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCreditControlReady(client);
    if (!ready) return res.status(400).json({ ok: false, error: "CREDIT_CONTROL_NOT_READY" });

    const ctx = await loadContextFilters(req, client);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const releaseId = normalizeId(req.params.id);
    if (!releaseId) return res.status(400).json({ ok: false, error: "INVALID_RELEASE" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = normalizeText(body.release_status);
    if (!["approved", "rejected", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_RELEASE_STATUS" });
    }

    const where = [`id = $1`];
    const params = [releaseId];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`distributor_id = $${params.length}`);
    } else {
      params.push(Number(ctx.activeCompanyId));
      where.push(`company_id = $${params.length}`);
    }
    const currentRes = await client.query(
      `select * from customer_credit_releases where ${where.join(" and ")} limit 1`,
      params
    );
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ ok: false, error: "RELEASE_NOT_FOUND" });
    if (String(current.release_status || "").toLowerCase() !== "requested") {
      return res.status(409).json({ ok: false, error: "RELEASE_NOT_EDITABLE" });
    }
    const isRequester = Number(current.requested_by) === Number(req.user.id);
    if (nextStatus === "approved" || nextStatus === "rejected") {
      if (!canApproveCreditRelease(req)) return res.status(403).json({ ok: false, error: "APPROVER_RIGHTS_REQUIRED" });
      if (isRequester && req.user.group_name !== "SuperAdmin") {
        return res.status(403).json({ ok: false, error: "SELF_APPROVAL_NOT_ALLOWED" });
      }
    }
    if (nextStatus === "cancelled" && !isRequester && !canApproveCreditRelease(req)) {
      return res.status(403).json({ ok: false, error: "ONLY_REQUESTER_OR_APPROVER_CAN_CANCEL" });
    }

    const approvedLimit = normalizeAmount(body.approved_upto_amount);
    const expiresOn = normalizeText(body.expires_on) || current.expires_on;
    if (nextStatus === "approved") {
      if (approvedLimit === null || approvedLimit <= 0) {
        return res.status(400).json({ ok: false, error: "INVALID_APPROVED_LIMIT" });
      }
      if (!expiresOn) return res.status(400).json({ ok: false, error: "INVALID_EXPIRY" });
    }

    const updateParams = [
      releaseId,
      nextStatus,
      nextStatus === "approved" ? approvedLimit : null,
      expiresOn,
      Number(req.user.id),
    ];
    const updateWhere = [`id = $1`];
    if (ctx.isDistributor) {
      updateParams.push(Number(ctx.distributorId));
      updateWhere.push(`distributor_id = $${updateParams.length}`);
    } else {
      updateParams.push(Number(ctx.activeCompanyId));
      updateWhere.push(`company_id = $${updateParams.length}`);
    }
    const r = await client.query(
      `
        update customer_credit_releases
        set release_status = $2,
            approved_upto_amount = case when $2 = 'approved' then $3 else approved_upto_amount end,
            expires_on = case when $2 = 'approved' then $4::date else expires_on end,
            approved_by = case when $2 = 'approved' then $5 else approved_by end,
            approved_at = case when $2 = 'approved' then now() else approved_at end,
            rejected_by = case when $2 = 'rejected' then $5 else rejected_by end,
            rejected_at = case when $2 = 'rejected' then now() else rejected_at end,
            cancelled_by = case when $2 = 'cancelled' then $5 else cancelled_by end,
            cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
            updated_at = now()
        where ${updateWhere.join(" and ")}
        returning *
      `,
      updateParams
    );
    if (!r.rows?.[0]) return res.status(404).json({ ok: false, error: "RELEASE_NOT_FOUND" });
    return res.json({ ok: true, release: r.rows[0] });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
