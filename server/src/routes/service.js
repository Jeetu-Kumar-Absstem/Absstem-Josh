const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  checkEquipmentCoverage,
  issueServiceTicketParts,
} = require("../services/serviceMaintenance");

const router = express.Router();

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * 1. Installed Equipment / Serialized Assets
 */
router.get("/equipment", requireScreenAction("service_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const search = cleanText(req.query.q, 80);

    let query = `
      select
        ie.*,
        c.customer_name,
        so.so_number,
        d.dispatch_number,
        (
          select count(*)
          from service_tickets st
          where st.installed_equipment_id = ie.id
        ) as total_tickets_logged
      from installed_equipment ie
      join customers c on c.id = ie.customer_id
      left join sales_orders so on so.id = ie.sales_order_id
      left join dispatches d on d.id = ie.dispatch_id
      where (ie.company_id = $1 or ie.company_id is null)
    `;
    const params = [companyId];

    if (search) {
      params.push(`%${search}%`);
      query += ` and (ie.serial_number ilike $${params.length} or ie.item_name ilike $${params.length} or c.customer_name ilike $${params.length})`;
    }

    query += ` order by ie.created_at desc limit 150`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, equipment: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/equipment", requireScreenAction("service_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const serialNumber = cleanText(req.body?.serial_number, 100);
    const customerId = Number(req.body?.customer_id);
    const itemName = cleanText(req.body?.item_name, 255);
    const itemCode = cleanText(req.body?.item_code, 100) || "FG-EQUIP";

    if (!serialNumber || !customerId || !itemName) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_EQUIPMENT_FIELDS" });
    }

    const insRes = await pool.query(
      `
        insert into installed_equipment (
          company_id, serial_number, product_id, item_code, item_name,
          customer_id, site_location, site_address, commissioning_date,
          warranty_start_date, warranty_end_date, equipment_status, notes, created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'operational', $12, $13)
        returning *
      `,
      [
        companyId,
        serialNumber,
        req.body?.product_id ? Number(req.body.product_id) : null,
        itemCode,
        itemName,
        customerId,
        cleanText(req.body?.site_location, 255),
        cleanText(req.body?.site_address, 500),
        req.body?.commissioning_date || new Date(),
        req.body?.warranty_start_date || new Date(),
        req.body?.warranty_end_date || new Date(Date.now() + 365 * 86400000),
        cleanText(req.body?.notes, 500),
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ ok: true, equipment: insRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

/**
 * 2. AMC Contracts Management
 */
router.get("/amc-contracts", requireScreenAction("service_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          amc.*,
          c.customer_name,
          ie.serial_number,
          ie.item_name as equipment_name,
          (
            select count(*)
            from amc_visits v
            where v.amc_contract_id = amc.id
          ) as total_visits
        from amc_contracts amc
        join customers c on c.id = amc.customer_id
        left join installed_equipment ie on ie.id = amc.installed_equipment_id
        where (amc.company_id = $1 or amc.company_id is null)
        order by amc.end_date desc, amc.id desc
        limit 150
      `,
      [companyId]
    );
    return res.json({ ok: true, contracts: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/amc-contracts", requireScreenAction("service_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const customerId = Number(req.body?.customer_id);
    const startDate = req.body?.start_date;
    const endDate = req.body?.end_date;
    const contractValue = Number(req.body?.contract_value || 0);

    if (!customerId || !startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_AMC_FIELDS" });
    }

    const numRes = await pool.query(`select next_company_document_number($1, 'AMC') as num`, [companyId]);
    const contractNumber = numRes.rows[0]?.num || `AMC-${Date.now().toString(36).toUpperCase()}`;

    const insRes = await pool.query(
      `
        insert into amc_contracts (
          company_id, contract_number, contract_status, contract_date,
          customer_id, installed_equipment_id, start_date, end_date,
          planned_visits, contract_value, remarks, created_by
        )
        values ($1, $2, 'active', current_date, $3, $4, $5, $6, $7, $8, $9, $10)
        returning *
      `,
      [
        companyId,
        contractNumber,
        customerId,
        req.body?.installed_equipment_id ? Number(req.body.installed_equipment_id) : null,
        startDate,
        endDate,
        Number(req.body?.planned_visits || 4),
        contractValue,
        cleanText(req.body?.remarks, 500),
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ ok: true, contract: insRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

/**
 * 3. Service Tickets & Field Dispatches
 */
router.get("/tickets", requireScreenAction("service_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = cleanText(req.query.status, 30);

    let query = `
      select
        st.*,
        c.customer_name,
        ie.serial_number,
        ie.item_name as equipment_name,
        u.display_name as assigned_engineer_name,
        (
          select count(*)
          from service_ticket_parts stp
          where stp.service_ticket_id = st.id
        ) as parts_consumed_count
      from service_tickets st
      join customers c on c.id = st.customer_id
      left join installed_equipment ie on ie.id = st.installed_equipment_id
      left join erp_users u on u.id = st.assigned_to_user_id
      where (st.company_id = $1 or st.company_id is null)
    `;
    const params = [companyId];

    if (status) {
      params.push(status);
      query += ` and st.ticket_status = $${params.length}`;
    }

    query += ` order by st.created_at desc limit 200`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, tickets: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/tickets", requireScreenAction("service_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const customerId = Number(req.body?.customer_id);
    const equipmentId = req.body?.installed_equipment_id ? Number(req.body.installed_equipment_id) : null;
    const symptomSummary = cleanText(req.body?.symptom_summary, 500);

    if (!customerId || !symptomSummary) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_TICKET_FIELDS" });
    }

    await client.query("begin");

    let isUnderWarranty = false;
    let isUnderAmc = false;
    let amcContractId = null;

    if (equipmentId) {
      const coverage = await checkEquipmentCoverage(client, equipmentId);
      isUnderWarranty = coverage.isUnderWarranty;
      isUnderAmc = coverage.isUnderAmc;
      amcContractId = coverage.activeAmc?.id || null;
    }

    const numRes = await client.query(`select next_company_document_number($1, 'TKT') as num`, [companyId]);
    const ticketNumber = numRes.rows[0]?.num || `TKT-${Date.now().toString(36).toUpperCase()}`;

    const insRes = await client.query(
      `
        insert into service_tickets (
          company_id, ticket_number, ticket_status, ticket_priority, complaint_type,
          customer_id, installed_equipment_id, amc_contract_id,
          assigned_to_user_id, site_name, site_address, reported_by,
          symptom_summary, remarks, is_under_warranty, is_under_amc, created_by
        )
        values ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        returning *
      `,
      [
        companyId,
        ticketNumber,
        cleanText(req.body?.ticket_priority, 20) || "normal",
        cleanText(req.body?.complaint_type, 30) || "breakdown",
        customerId,
        equipmentId,
        amcContractId,
        req.body?.assigned_to_user_id ? Number(req.body.assigned_to_user_id) : null,
        cleanText(req.body?.site_name, 255),
        cleanText(req.body?.site_address, 500),
        cleanText(req.body?.reported_by, 100),
        symptomSummary,
        cleanText(req.body?.remarks, 500),
        isUnderWarranty,
        isUnderAmc,
        req.user?.id || null,
      ]
    );

    await client.query("commit");
    return res.status(201).json({ ok: true, ticket: insRes.rows[0] });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/tickets/:id/issue-parts", requireScreenAction("service_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const serviceTicketId = Number(req.params.id);
    const productId = Number(req.body?.product_id);
    const itemCode = cleanText(req.body?.item_code, 100);
    const itemName = cleanText(req.body?.item_name, 255);
    const qtyIssued = Number(req.body?.qty_issued || 1);

    if (!serviceTicketId || !productId || !itemCode || !itemName || qtyIssued <= 0) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_PARTS_FIELDS" });
    }

    await client.query("begin");
    const part = await issueServiceTicketParts(client, {
      companyId,
      serviceTicketId,
      productId,
      itemCode,
      itemName,
      uom: cleanText(req.body?.uom, 20) || "NOS",
      qtyIssued,
      userId: req.user?.id || null,
    });
    await client.query("commit");

    return res.status(201).json({ ok: true, part, message: "Spare parts issued, inventory deducted & GL posted." });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

router.patch("/tickets/:id/status", requireScreenAction("service_desk", "can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const ticketId = Number(req.params.id);
    const status = cleanText(req.body?.status, 30);
    const resolutionNotes = cleanText(req.body?.resolution_notes, 1000);

    if (!ticketId || !status) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS_UPDATE" });
    }

    const upRes = await pool.query(
      `
        update service_tickets
        set ticket_status = $1,
            resolution_notes = coalesce($2, resolution_notes),
            resolved_at = case when $1 in ('resolved', 'closed') then now() else resolved_at end,
            updated_at = now()
        where id = $3 and (company_id = $4 or company_id is null)
        returning *
      `,
      [status, resolutionNotes, ticketId, companyId]
    );

    return res.json({ ok: true, ticket: upRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
