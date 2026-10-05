const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { recordAuditLog } = require("../services/systemAudit");
const { runO2cRepairs } = require("../services/o2cChainRepair");

const router = express.Router();

const OPS = [
  {
    key: "o2c_repair",
    label: "O2C chain repair",
    description: "Receipt Against-Ref allocations, invoice↔SO links, SO line backfill from invoices.",
    confirmPhrase: "REPAIR O2C",
    destructive: true,
  },
  {
    key: "wipe_so_commercial_preview",
    label: "Wipe SO commercial chain (preview only)",
    description: "Counts SOs/invoices/receipts that a wipe-chain would touch. Apply is blocked in UI — use CLI with typed guard.",
    confirmPhrase: "PREVIEW WIPE",
    destructive: false,
    applyBlocked: true,
  },
];

router.get("/catalog", requireScreenAction("data_ops", "can_view"), async (_req, res) => {
  return res.json({ ok: true, ops: OPS });
});

router.get("/runs", requireScreenAction("data_ops", "can_view"), async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 40)));
    const { rows } = await pool.query(
      `
        select
          r.*,
          u.full_name as actor_name,
          u.email as actor_email
        from data_ops_runs r
        left join erp_users u on u.id = r.actor_id
        order by r.created_at desc
        limit $1
      `,
      [limit]
    );
    return res.json({ ok: true, runs: rows });
  } catch (err) {
    if (String(err?.message || "").includes("data_ops_runs")) {
      return res.json({ ok: true, runs: [], ready: false });
    }
    return next(err);
  }
});

async function logRun(client, payload) {
  try {
    const { rows } = await client.query(
      `
        insert into data_ops_runs (
          company_id, op_key, mode, confirm_phrase, request_payload, result_payload, status, actor_id
        )
        values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
        returning *
      `,
      [
        payload.companyId,
        payload.opKey,
        payload.mode,
        payload.confirmPhrase || null,
        JSON.stringify(payload.request || {}),
        JSON.stringify(payload.result || {}),
        payload.status || "ok",
        payload.actorId || null,
      ]
    );
    return rows[0];
  } catch (err) {
    if (String(err?.message || "").includes("data_ops_runs")) return null;
    throw err;
  }
}

router.post("/run", requireScreenAction("data_ops", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const opKey = String(body.op_key || "").trim();
    const op = OPS.find((row) => row.key === opKey);
    if (!op) return res.status(400).json({ ok: false, error: "UNKNOWN_OP" });

    const apply = body.apply === true;
    if (apply && op.applyBlocked) {
      return res.status(400).json({ ok: false, error: "APPLY_BLOCKED", message: "This operation is dry-run only from Data Ops." });
    }
    if (apply) {
      const phrase = String(body.confirm_phrase || "").trim();
      if (phrase !== op.confirmPhrase) {
        return res.status(400).json({ ok: false, error: "CONFIRM_PHRASE_REQUIRED", expected: op.confirmPhrase });
      }
    }

    const companyId = requireResolvedCompanyId(req) || null;
    const mode = apply ? "apply" : "dry_run";
    let result = null;

    if (opKey === "o2c_repair") {
      if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      await client.query("begin");
      result = await runO2cRepairs(client, {
        companyId,
        apply,
        steps: Array.isArray(body.steps) && body.steps.length ? body.steps : ["A", "B", "C"],
      });
      if (apply) await client.query("commit");
      else await client.query("rollback");
    } else if (opKey === "wipe_so_commercial_preview") {
      if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      const counts = await client.query(
        `
          select
            (select count(*)::int from sales_orders where company_id = $1) as sales_orders,
            (select count(*)::int from customer_invoices where company_id = $1) as invoices,
            (select count(*)::int from customer_receipts where company_id = $1) as receipts,
            (select count(*)::int from dispatches where company_id = $1) as dispatches
        `,
        [companyId]
      );
      result = {
        mode: "preview_only",
        company_id: companyId,
        counts: counts.rows[0] || {},
        note: "Apply wipe remains CLI-only (server/scripts/wipe-so-commercial-chain.js).",
      };
    }

    const runRow = await logRun(client, {
      companyId,
      opKey,
      mode,
      confirmPhrase: body.confirm_phrase || null,
      request: { steps: body.steps || null, apply },
      result,
      status: "ok",
      actorId: req.user?.id || null,
    });

    await recordAuditLog(client, {
      companyId,
      actorId: req.user?.id || null,
      actionType: apply ? "DATA_OPS_APPLY" : "DATA_OPS_DRY_RUN",
      module: "SYSTEM_ADMIN",
      targetTable: "data_ops_runs",
      targetId: runRow?.id || null,
      newPayload: { op_key: opKey, mode, result_summary: result },
      remarks: `Data Ops ${mode}: ${opKey}`,
    });

    return res.json({ ok: true, mode, op: opKey, result, run: runRow });
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (_e) {
      /* ignore */
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
