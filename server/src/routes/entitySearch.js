const express = require("express");
const { pool } = require("../db/pool");
const { hasScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId, getActiveCompanyId } = require("../services/companyContext");
const { buildCustomerCompanyScopeSql } = require("../services/customerCompanyAccess");

const router = express.Router();

const LIMIT_PER_TYPE = 5;
const LIMIT_SINGLE_TYPE = 12;
const MAX_ENTITIES = 30;
const ENTITY_KINDS = new Set(["quote", "sales_order", "purchase_order", "invoice", "customer", "vendor", "item"]);

function parseKinds(raw) {
  const kinds = String(raw || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => ENTITY_KINDS.has(k));
  return kinds.length ? new Set(kinds) : null;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

const COLUMN_RECHECK_MS = 5 * 60 * 1000;
const columnCache = new Map();

/** products.merged_into_product_id arrives with migration 189; stay usable on databases without it. */
async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  const cached = columnCache.get(key);
  if (cached && (cached.present || Date.now() - cached.at < COLUMN_RECHECK_MS)) return cached.present;
  const r = await pool.query(
    `select 1 from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2 limit 1`,
    [table, column]
  );
  const present = r.rowCount > 0;
  columnCache.set(key, { present, at: Date.now() });
  return present;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

/**
 * Ranking: exact code match (0) → code prefix (1) → anything else (2).
 * `$1` is the contains pattern, `$2` the prefix pattern, `$3` the exact term (lowercased).
 */
function rankSql(codeExpr) {
  return `case when lower(coalesce(${codeExpr}, '')) = $3 then 0 when coalesce(${codeExpr}, '') ilike $2 then 1 else 2 end`;
}

/**
 * GET /api/search/entities?q=
 * Entity jump for Command Palette — quote / SO / PO / invoice / customer / vendor / item codes.
 * Every entity type is gated by its own screen right and scoped to the active company.
 */
router.get("/entities", requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q.length < 2) return res.json({ ok: true, entities: [] });

    const kinds = parseKinds(req.query.kind);
    const want = (kind) => !kinds || kinds.has(kind);
    const perType = kinds && kinds.size === 1 ? LIMIT_SINGLE_TYPE : LIMIT_PER_TYPE;
    const companyId = requireResolvedCompanyId(req) || getActiveCompanyId(req) || null;
    const escaped = escapeLike(q);
    const base = [`%${escaped}%`, `${escaped}%`, q.toLowerCase()];
    const entities = [];
    const failedKinds = [];

    const run = async (sql, extra = [], kind = "unknown") => {
      const params = [...base, ...extra];
      try {
        const r = await pool.query(sql, params);
        return r.rows;
      } catch (err) {
        failedKinds.push(kind);
        process.stderr.write(`[entity-search] ${kind} lookup failed: ${err?.message || err}\n`);
        return [];
      }
    };
    const companyClause = (column, extraParams) => {
      if (!companyId) return "";
      extraParams.push(companyId);
      return ` and ${column} = $${base.length + extraParams.length}`;
    };
    const limitClause = (extraParams) => {
      extraParams.push(perType);
      return `limit $${base.length + extraParams.length}`;
    };

    if (want("quote") && hasScreenAction(req, "quotes", "can_view")) {
      const extra = [];
      const scope = companyClause("q.company_id", extra);
      const rows = await run(
        `
          select q.id, q.quote_number, q.quote_status, c.customer_name
          from quote_headers q
          left join customers c on c.id = q.customer_id
          where q.quote_number ilike $1${scope}
          order by ${rankSql("q.quote_number")}, q.updated_at desc nulls last, q.id desc
          ${limitClause(extra)}
        `,
        extra,
        "quote"
      );
      for (const row of rows) {
        entities.push({
          kind: "quote",
          kind_label: "Quote",
          id: row.id,
          label: row.quote_number,
          detail: [row.customer_name, row.quote_status].filter(Boolean).join(" · ") || "Quote",
          page: "quotes",
          launch: { openQuoteId: row.id },
        });
      }
    }

    if (want("sales_order") && hasScreenAction(req, "sales_orders", "can_view")) {
      const extra = [];
      const scope = companyClause("so.company_id", extra);
      const rows = await run(
        `
          select so.id, so.so_number, so.job_no, so.order_status,
                 coalesce(so.customer_po_number, so.buyer_po_number) as customer_po,
                 c.customer_name
          from sales_orders so
          left join customers c on c.id = so.customer_id
          where (
            so.so_number ilike $1
            or coalesce(so.job_no, '') ilike $1
            or coalesce(so.customer_po_number, so.buyer_po_number, '') ilike $1
          )${scope}
          order by ${rankSql("so.so_number")}, so.created_at desc, so.id desc
          ${limitClause(extra)}
        `,
        extra,
        "sales_order"
      );
      for (const row of rows) {
        const matchedPo = row.customer_po && String(row.customer_po).toLowerCase().includes(q.toLowerCase());
        const matchedJob = row.job_no && String(row.job_no).toLowerCase().includes(q.toLowerCase());
        const hint = matchedPo ? `Customer PO ${row.customer_po}` : matchedJob ? `Job ${row.job_no}` : row.order_status;
        entities.push({
          kind: "sales_order",
          kind_label: "Sales order",
          id: row.id,
          label: row.so_number,
          detail: [row.customer_name, hint].filter(Boolean).join(" · ") || "Sales order",
          page: "sales_orders",
          launch: { openSalesOrderId: row.id },
        });
      }
    }

    if (want("purchase_order") && hasScreenAction(req, "purchase_orders", "can_view")) {
      const extra = [];
      const scope = companyClause("po.company_id", extra);
      const rows = await run(
        `
          select po.id, po.po_number, po.po_status, v.company_name as vendor_name
          from purchase_orders po
          left join vendors v on v.id = po.vendor_id
          where po.po_number ilike $1${scope}
          order by ${rankSql("po.po_number")}, po.created_at desc, po.id desc
          ${limitClause(extra)}
        `,
        extra,
        "purchase_order"
      );
      for (const row of rows) {
        entities.push({
          kind: "purchase_order",
          kind_label: "Purchase order",
          id: row.id,
          label: row.po_number,
          detail: [row.vendor_name, row.po_status].filter(Boolean).join(" · ") || "Purchase order",
          page: "purchase_orders",
          launch: { openPurchaseOrderId: row.id },
        });
      }
    }

    if (want("invoice") && hasScreenAction(req, "invoices", "can_view")) {
      const extra = [];
      const scope = companyClause("ci.company_id", extra);
      const rows = await run(
        `
          select ci.id, ci.invoice_number, ci.invoice_status, c.customer_name
          from customer_invoices ci
          left join customers c on c.id = ci.customer_id
          where ci.invoice_number ilike $1${scope}
          order by ${rankSql("ci.invoice_number")}, ci.created_at desc, ci.id desc
          ${limitClause(extra)}
        `,
        extra,
        "invoice"
      );
      for (const row of rows) {
        entities.push({
          kind: "invoice",
          kind_label: "Invoice",
          id: row.id,
          label: row.invoice_number,
          detail: [row.customer_name, row.invoice_status].filter(Boolean).join(" · ") || "Invoice",
          page: "invoices",
          launch: { openInvoiceId: row.id },
        });
      }
    }

    if (want("customer") && hasScreenAction(req, "customers", "can_view")) {
      const extra = [];
      let scope = "";
      if (companyId) {
        extra.push(companyId);
        scope = ` and ${buildCustomerCompanyScopeSql("c.id", `$${base.length + extra.length}`)}`;
      }
      const rows = await run(
        `
          select c.id, c.customer_code, c.customer_name, c.city
          from customers c
          where c.is_active = true
            and c.merged_into_customer_id is null
            and (
              coalesce(c.customer_code, '') ilike $1
              or c.customer_name ilike $1
              or coalesce(c.legal_name, '') ilike $1
            )${scope}
          order by ${rankSql("c.customer_code")}, case when c.customer_name ilike $2 then 0 else 1 end, c.customer_name asc
          ${limitClause(extra)}
        `,
        extra,
        "customer"
      );
      for (const row of rows) {
        entities.push({
          kind: "customer",
          kind_label: "Customer",
          id: row.id,
          label: row.customer_name || row.customer_code,
          detail: [row.customer_code, row.city].filter(Boolean).join(" · ") || "Customer",
          page: "customers",
          launch: { openCustomerId: row.id },
        });
      }
    }

    if (want("vendor") && hasScreenAction(req, "admin_masters", "can_view")) {
      const extra = [];
      let scope = "";
      if (companyId) {
        extra.push(companyId);
        scope = ` and (v.company_id is null or v.company_id = $${base.length + extra.length})`;
      }
      const rows = await run(
        `
          select v.id, v.vendor_code, v.company_name, v.company_id
          from vendors v
          where (coalesce(v.vendor_code, '') ilike $1 or v.company_name ilike $1)${scope}
          order by ${rankSql("v.vendor_code")}, case when v.company_name ilike $2 then 0 else 1 end, v.company_name asc
          ${limitClause(extra)}
        `,
        extra,
        "vendor"
      );
      for (const row of rows) {
        entities.push({
          kind: "vendor",
          kind_label: "Vendor",
          id: row.id,
          label: row.company_name || row.vendor_code,
          detail: row.vendor_code || "Vendor",
          page: "admin_masters",
          launch: {
            adminLaunch: {
              activeSection: "vendors",
              vendor_id: row.id,
              ...(row.company_id ? { companyId: row.company_id } : {}),
            },
          },
        });
      }
    }

    const canDesk = hasScreenAction(req, "product_master_desk", "can_view");
    const canAdmin = hasScreenAction(req, "product_master", "can_view");
    if (want("item") && (canDesk || canAdmin)) {
      const extra = [];
      const mergeFilter = (await hasColumn("products", "merged_into_product_id").catch(() => false))
        ? "and p.merged_into_product_id is null"
        : "";
      const rows = await run(
        `
          select p.id, p.item_code, p.item_name
          from products p
          where coalesce(p.is_active, true) = true
            ${mergeFilter}
            and (
              p.item_code ilike $1
              or coalesce(p.item_name, '') ilike $1
              or coalesce(p.sku, '') ilike $1
            )
          order by ${rankSql("p.item_code")}, p.item_code asc
          ${limitClause(extra)}
        `,
        extra,
        "item"
      );
      for (const row of rows) {
        const deskLaunch = { productDeskLaunch: { q: row.item_code, product_id: row.id } };
        entities.push({
          kind: "item",
          kind_label: "Item",
          id: row.id,
          label: row.item_code,
          detail: row.item_name || "Item",
          page: canDesk ? "product_master_desk" : "product_master",
          launch: canDesk ? deskLaunch : null,
          ...(canDesk && canAdmin ? { alt_page: "product_master", alt_launch: null } : {}),
        });
      }
    }

    return res.json({
      ok: true,
      q,
      kinds: kinds ? [...kinds] : null,
      entities: entities.slice(0, MAX_ENTITIES),
      ...(failedKinds.length ? { partial: true, failed_kinds: failedKinds } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
