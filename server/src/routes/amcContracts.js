const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function toInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function canAccessAmc(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "amc_contracts")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function addDays(dateString, days) {
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

async function getDispatchSeedHeader(client, dispatchId) {
  const r = await client.query(
    `
      select
        d.id,
        d.dispatch_number,
        d.dispatch_date,
        d.sales_order_id,
        d.customer_id,
        d.created_by as dispatch_created_by,
        c.customer_name,
        so.so_number,
        (
          select ci.id
          from customer_invoices ci
          where ci.sales_order_id = d.sales_order_id
            and ci.invoice_status <> 'cancelled'
          order by ci.invoice_date desc nulls last, ci.id desc
          limit 1
        ) as customer_invoice_id
      from dispatches d
      join customers c on c.id = d.customer_id
      join sales_orders so on so.id = d.sales_order_id
      where d.id = $1
      limit 1
    `,
    [dispatchId]
  );
  return r.rows[0] || null;
}

async function getDispatchSeedLines(client, dispatchId) {
  const r = await client.query(
    `
      select
        dl.id as dispatch_line_id,
        dl.line_no,
        dl.item_code,
        dl.item_name,
        dl.uom,
        dl.qty_dispatch as qty_covered,
        sol.product_id
      from dispatch_lines dl
      left join sales_order_lines sol on sol.id = dl.sales_order_line_id
      where dl.dispatch_id = $1
      order by dl.line_no asc, dl.id asc
    `,
    [dispatchId]
  );
  return r.rows;
}

async function generateVisitRows({ startDate, plannedVisits, visitFrequencyDays }) {
  const rows = [];
  let due = startDate;
  for (let index = 0; index < plannedVisits; index += 1) {
    rows.push({ visit_no: index + 1, due_date: due });
    due = addDays(due, visitFrequencyDays);
  }
  return rows;
}

async function getAmcHeaderOrNull(client, id) {
  const r = await client.query(
    `
      select
        ac.*,
        c.customer_name,
        d.dispatch_number,
        so.so_number,
        ci.invoice_number,
        u.full_name as created_by_name,
        coalesce((select count(*) from amc_visits where amc_contract_id = ac.id and visit_status = 'completed'), 0) as visits_completed,
        coalesce((select count(*) from amc_visits where amc_contract_id = ac.id), 0) as visits_total
      from amc_contracts ac
      join customers c on c.id = ac.customer_id
      join dispatches d on d.id = ac.dispatch_id
      left join sales_orders so on so.id = ac.sales_order_id
      left join customer_invoices ci on ci.id = ac.customer_invoice_id
      left join erp_users u on u.id = ac.created_by
      where ac.id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getAmcLines(client, id) {
  const r = await client.query(
    `
      select *
      from amc_contract_lines
      where amc_contract_id = $1
      order by line_no asc
    `,
    [id]
  );
  return r.rows;
}

async function getAmcVisits(client, id) {
  const r = await client.query(
    `
      select
        av.*,
        swc.case_number as service_case_number
      from amc_visits av
      left join service_warranty_cases swc on swc.id = av.service_warranty_case_id
      where av.amc_contract_id = $1
      order by av.visit_no asc
    `,
    [id]
  );
  return r.rows;
}

router.get("/bootstrap", requireScreenAction("amc_contracts", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let ownFilter = "";
    if (ownRecordsOnly(req, "amc_contracts")) {
      params.push(Number(req.user.id));
      ownFilter = ` and d.created_by = $${params.length}`;
    }
    const r = await pool.query(
      `
        select
          d.id,
          d.dispatch_number,
          d.dispatch_date,
          c.customer_name,
          so.so_number
        from dispatches d
        join customers c on c.id = d.customer_id
        join sales_orders so on so.id = d.sales_order_id
        where d.dispatch_status in ('dispatched', 'delivered')
        ${ownFilter}
        order by d.dispatch_date desc, d.id desc
        limit 200
      `,
      params
    );
    return res.json({ ok: true, dispatches: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("amc_contracts", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    if (ownRecordsOnly(req, "amc_contracts")) {
      params.push(Number(req.user.id));
      where = `where ac.created_by = $${params.length}`;
    }
    const r = await pool.query(
      `
        select
          ac.id,
          ac.contract_number,
          ac.contract_status,
          ac.start_date,
          ac.end_date,
          ac.next_due_date,
          c.customer_name,
          d.dispatch_number,
          coalesce((select count(*) from amc_visits where amc_contract_id = ac.id and visit_status = 'completed'), 0) as visits_completed,
          coalesce((select count(*) from amc_visits where amc_contract_id = ac.id), 0) as visits_total
        from amc_contracts ac
        join customers c on c.id = ac.customer_id
        join dispatches d on d.id = ac.dispatch_id
        ${where}
        order by ac.created_at desc, ac.id desc
      `,
      params
    );
    return res.json({ ok: true, amc_contracts: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-dispatch/:id", requireScreenAction("amc_contracts", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const dispatchId = Number(req.params.id);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) return res.status(400).json({ ok: false, error: "INVALID_DISPATCH" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const visitFrequencyDays = toInt(body.visit_frequency_days, 90);
    const plannedVisits = toInt(body.planned_visits, 4);
    const startDate = String(body.start_date || "").slice(0, 10);
    const endDate = String(body.end_date || "").slice(0, 10);
    if (!startDate || !endDate) return res.status(400).json({ ok: false, error: "INVALID_DATES" });
    if (visitFrequencyDays <= 0 || plannedVisits <= 0) return res.status(400).json({ ok: false, error: "INVALID_VISIT_PLAN" });

    await client.query("begin");
    const header = await getDispatchSeedHeader(client, dispatchId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "DISPATCH_NOT_FOUND" });
    }
    if (ownRecordsOnly(req, "amc_contracts") && req.user.group_name !== "SuperAdmin" && Number(header.dispatch_created_by) !== Number(req.user.id)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const lines = (await getDispatchSeedLines(client, dispatchId)).filter((line) => qty(line.qty_covered) > 0);
    if (!lines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_ELIGIBLE_LINES" });
    }

    const numRes = await client.query(`select next_document_number('AMC') as contract_number`);
    const contractNumber = numRes.rows[0]?.contract_number;
    const insertContract = await client.query(
      `
        insert into amc_contracts (
          contract_number,
          contract_status,
          contract_date,
          customer_id,
          sales_order_id,
          dispatch_id,
          customer_invoice_id,
          start_date,
          end_date,
          visit_frequency_days,
          planned_visits,
          next_due_date,
          remarks,
          created_by
        )
        values ($1,'active',current_date,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10,$11)
        returning id
      `,
      [contractNumber, header.customer_id, header.sales_order_id || null, dispatchId, header.customer_invoice_id || null, startDate, endDate, visitFrequencyDays, plannedVisits, normalizeText(body.remarks), req.user.id]
    );
    const contractId = insertContract.rows[0]?.id;

    let lineNo = 1;
    for (const line of lines) {
      await client.query(
        `
          insert into amc_contract_lines (
            amc_contract_id,
            dispatch_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            uom,
            qty_covered,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [contractId, line.dispatch_line_id, lineNo, line.product_id || null, line.item_code || null, line.item_name || null, line.uom || null, qty(line.qty_covered), null]
      );
      lineNo += 1;
    }

    const visitRows = await generateVisitRows({ startDate, plannedVisits, visitFrequencyDays });
    for (const visit of visitRows) {
      await client.query(
        `
          insert into amc_visits (
            amc_contract_id,
            visit_no,
            due_date,
            visit_status,
            created_by
          )
          values ($1,$2,$3,'scheduled',$4)
        `,
        [contractId, visit.visit_no, visit.due_date, req.user.id]
      );
    }

    await client.query("commit");
    const contract = await getAmcHeaderOrNull(client, contractId);
    const contractLines = await getAmcLines(client, contractId);
    const visits = await getAmcVisits(client, contractId);
    return res.status(201).json({ ok: true, amc_contract: contract, lines: contractLines, visits });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("amc_contracts", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const contract = await getAmcHeaderOrNull(pool, id);
    if (!contract) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessAmc(req, contract)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const lines = await getAmcLines(pool, id);
    const visits = await getAmcVisits(pool, id);
    return res.json({ ok: true, amc_contract: contract, lines, visits });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("amc_contracts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const contractStatus = typeof body.contract_status === "string" ? body.contract_status.trim().toLowerCase() : "active";
    if (!["draft", "active", "expired", "closed", "cancelled"].includes(contractStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    await client.query("begin");
    const contract = await getAmcHeaderOrNull(client, id);
    if (!contract) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessAmc(req, contract)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const nextDueDate = normalizeText(body.next_due_date) || contract.next_due_date || null;
    await client.query(
      `
        update amc_contracts
        set contract_status = $2,
            next_due_date = $3,
            remarks = $4,
            updated_at = now()
        where id = $1
      `,
      [id, contractStatus, nextDueDate, normalizeText(body.remarks)]
    );

    if (Array.isArray(body.visits)) {
      for (const visit of body.visits) {
        const visitId = Number(visit.id);
        if (!Number.isFinite(visitId) || visitId <= 0) continue;
        const visitStatus = typeof visit.visit_status === "string" ? visit.visit_status.trim().toLowerCase() : "scheduled";
        if (!["scheduled", "completed", "missed", "cancelled"].includes(visitStatus)) continue;
        await client.query(
          `
            update amc_visits
            set due_date = coalesce($2, due_date),
                visit_status = $3,
                technician_name = $4,
                completed_at = case when $3 = 'completed' then coalesce($5, current_date) else null end,
                remarks = $6,
                updated_at = now()
            where id = $1 and amc_contract_id = $7
          `,
          [visitId, visit.due_date || null, visitStatus, normalizeText(visit.technician_name), visit.completed_at || null, normalizeText(visit.remarks), id]
        );
      }
    }

    await client.query("commit");
    const nextContract = await getAmcHeaderOrNull(client, id);
    const lines = await getAmcLines(client, id);
    const visits = await getAmcVisits(client, id);
    return res.json({ ok: true, amc_contract: nextContract, lines, visits });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/visits/:visitId/create-service-case", requireScreenAction("amc_contracts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const visitId = Number(req.params.visitId);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(visitId) || visitId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ID" });
    }
    await client.query("begin");
    const contract = await getAmcHeaderOrNull(client, id);
    if (!contract) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessAmc(req, contract)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const visitRes = await client.query(`select * from amc_visits where id = $1 and amc_contract_id = $2 limit 1`, [visitId, id]);
    const visit = visitRes.rows[0] || null;
    if (!visit) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "VISIT_NOT_FOUND" });
    }
    if (visit.service_warranty_case_id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "SERVICE_CASE_ALREADY_CREATED" });
    }
    const dispatch = await getDispatchSeedHeader(client, contract.dispatch_id);
    const dispatchLines = await getDispatchSeedLines(client, contract.dispatch_id);
    const eligibleLines = dispatchLines.filter((line) => Number(line.product_id) > 0 && qty(line.qty_covered) > 0);
    if (!dispatch || !eligibleLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "DISPATCH_NOT_ELIGIBLE" });
    }

    const caseNumberRes = await client.query(`select next_document_number('SWC') as case_number`);
    const caseNumber = caseNumberRes.rows[0]?.case_number;
    const insertCase = await client.query(
      `
        insert into service_warranty_cases (
          case_number,
          case_status,
          case_date,
          customer_id,
          sales_order_id,
          dispatch_id,
          customer_invoice_id,
          issue_type,
          reported_by,
          remarks,
          created_by
        )
        values ($1,'open',current_date,$2,$3,$4,$5,'service',$6,$7,$8)
        returning id
      `,
      [caseNumber, dispatch.customer_id, dispatch.sales_order_id || null, dispatch.id, dispatch.customer_invoice_id || null, `AMC Visit ${visit.visit_no}`, `Created from AMC ${contract.contract_number}`, req.user.id]
    );
    const serviceCaseId = insertCase.rows[0]?.id;
    let lineNo = 1;
    for (const line of eligibleLines) {
      await client.query(
        `
          insert into service_warranty_case_lines (
            service_warranty_case_id,
            dispatch_line_id,
            sales_order_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            uom,
            serial_no_required,
            qty_eligible,
            remarks
          )
          values ($1,$2,null,$3,$4,$5,$6,$7,$8,false,$9,$10)
        `,
        [serviceCaseId, line.dispatch_line_id, lineNo, line.product_id || null, line.item_code || null, line.item_name || null, line.item_name || null, line.uom || null, qty(line.qty_covered), "Created from AMC visit"]
      );
      lineNo += 1;
    }
    await client.query(
      `
        update amc_visits
        set service_warranty_case_id = $2,
            updated_at = now()
        where id = $1
      `,
      [visitId, serviceCaseId]
    );

    await client.query("commit");
    const nextContract = await getAmcHeaderOrNull(client, id);
    const lines = await getAmcLines(client, id);
    const visits = await getAmcVisits(client, id);
    return res.status(201).json({ ok: true, amc_contract: nextContract, lines, visits, service_case_id: serviceCaseId });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
