const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");

const router = express.Router();

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

router.use(requireSuperAdmin);

router.get("/bootstrap", requireScreenAction("intercompany_partners", "can_view"), async (_req, res, next) => {
  try {
    const [companiesRes, vendorsRes, customersRes] = await Promise.all([
      pool.query(
        `
          select id, company_code, display_name, legal_name
          from companies
          where is_active = true
          order by company_code asc
        `
      ),
      pool.query(
        `
          select id, vendor_code, company_name
          from vendors
          where is_active = true
          order by company_name asc
        `
      ),
      pool.query(
        `
          select id, customer_code, customer_name
          from customers
          where is_active = true
          order by customer_name asc
        `
      ),
    ]);

    return res.json({
      ok: true,
      companies: companiesRes.rows,
      vendors: vendorsRes.rows,
      customers: customersRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("intercompany_partners", "can_view"), async (_req, res, next) => {
  try {
    const r = await pool.query(
      `
        select
          p.*,
          co.company_code as company_code,
          co.display_name as company_name,
          cco.company_code as counterparty_company_code,
          cco.display_name as counterparty_company_name,
          v.company_name as vendor_name,
          cu.customer_name as customer_name
        from intercompany_partners p
        join companies co on co.id = p.company_id
        join companies cco on cco.id = p.counterparty_company_id
        left join vendors v on v.id = p.vendor_id
        left join customers cu on cu.id = p.customer_id
        order by co.company_code asc, cco.company_code asc, p.id asc
      `
    );
    return res.json({ ok: true, partners: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("intercompany_partners", "can_create"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = asInt(body.company_id);
    const counterpartyCompanyId = asInt(body.counterparty_company_id);
    const vendorId = body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === "" ? null : asInt(body.vendor_id);
    const customerId = body.customer_id === undefined || body.customer_id === null || body.customer_id === "" ? null : asInt(body.customer_id);
    const isActive = body.is_active !== false;

    if (!companyId || companyId <= 0) return res.status(400).json({ ok: false, error: "INVALID_COMPANY" });
    if (!counterpartyCompanyId || counterpartyCompanyId <= 0) return res.status(400).json({ ok: false, error: "INVALID_COUNTERPARTY" });
    if (companyId === counterpartyCompanyId) return res.status(400).json({ ok: false, error: "SAME_COMPANY_NOT_ALLOWED" });

    const r = await pool.query(
      `
        insert into intercompany_partners (
          company_id,
          counterparty_company_id,
          vendor_id,
          customer_id,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,now())
        returning id
      `,
      [companyId, counterpartyCompanyId, vendorId, customerId, isActive]
    );

    return res.status(201).json({ ok: true, id: r.rows[0]?.id || null });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_MAPPING" });
    return next(err);
  }
});

router.put("/:id", requireScreenAction("intercompany_partners", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === "" ? null : asInt(body.vendor_id);
    const customerId = body.customer_id === undefined || body.customer_id === null || body.customer_id === "" ? null : asInt(body.customer_id);
    const isActive = body.is_active !== false;

    const r = await pool.query(
      `
        update intercompany_partners
        set vendor_id = $1,
            customer_id = $2,
            is_active = $3,
            updated_at = now()
        where id = $4
        returning id
      `,
      [vendorId, customerId, isActive, id]
    );
    if (!r.rows[0]?.id) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
