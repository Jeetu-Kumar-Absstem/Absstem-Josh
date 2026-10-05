const fs = require("fs");
const path = require("path");

const { pool } = require("../db/pool");

const ROOT = path.resolve(__dirname, "..", "..", "..");

const SNAPSHOTS = {
  AI: {
    company_key: "AI",
    label: "AI • Absstem Industrial",
    gap_file: "Clan_vs_ProductMaster_AI_gap_2026-09-10.json",
  },
  AT: {
    company_key: "AT",
    label: "AT • ABSSTEM Technologies",
    gap_file: "Clan_vs_ProductMaster_AT_gap_2026-09-10.json",
  },
};

const EXCEPTION_TYPES = ["not_in_josh", "no_company_policy", "awaiting_tax", "needs_review"];
const MAPPABLE_TYPES = new Set(["not_in_josh", "no_company_policy"]);
const CLAN_IMPORT_REMARK = "Clan import — complete HSN/GST, then activate";

function safeReadJson(fileName) {
  const full = path.join(ROOT, fileName);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isActiveClan(row) {
  const flag = String(row?.active || "")
    .trim()
    .toUpperCase();
  return flag === "YES" || flag === "Y" || flag === "TRUE" || flag === "1";
}

function reviewReason(row) {
  const code = String(row?.code || "").trim();
  const name = String(row?.name || "").trim();
  if (!name) return "Clan row has no item name";
  if (/^(test|dummy|sample|xx+|na|n\/a)$/i.test(name)) return `Placeholder name "${name}"`;
  if (!String(row?.category || "").trim()) return "Clan row has no category";
  if (!String(row?.group || "").trim()) return "Clan row has no group";
  if (/\s/.test(code)) return "Item code contains spaces";
  return null;
}

async function resolveCompanyId(db, companyKey) {
  const res = await db.query(`select id from companies where upper(trim(company_code)) = $1 limit 1`, [companyKey]);
  return res.rows[0]?.id || null;
}

async function loadLiveState(db, companyId) {
  const { rows } = await db.query(
    `
      select
        upper(trim(p.item_code)) as code,
        p.id,
        p.is_active,
        coalesce(trim(p.hsn_no), '') as hsn_no,
        coalesce(p.gst_pct, 0) as gst_pct,
        (cpp.id is not null) as has_policy
      from products p
      left join company_product_policies cpp
        on cpp.product_id = p.id and cpp.company_id = $1
      where p.item_code is not null and trim(p.item_code) <> ''
    `,
    [companyId]
  );
  const map = new Map();
  for (const row of rows) map.set(row.code, row);
  return map;
}

function classify(row, live) {
  const review = reviewReason(row);
  if (!live) {
    if (review) return { type: "needs_review", reason: review };
    return { type: "not_in_josh", reason: "Active in Clan, no Josh product with this item code" };
  }
  if (!live.has_policy) return { type: "no_company_policy", reason: "Product exists but has no policy for this company" };
  const taxMissing = !live.hsn_no || Number(live.gst_pct) <= 0;
  if (taxMissing || !live.is_active) {
    const parts = [];
    if (!live.hsn_no) parts.push("HSN");
    if (Number(live.gst_pct) <= 0) parts.push("GST %");
    const missing = parts.length ? `${parts.join(" and ")} missing` : "Tax data present";
    return { type: "awaiting_tax", reason: live.is_active ? missing : `${missing} — inactive until completed` };
  }
  return { type: "mapped", reason: null };
}

async function buildClassifiedRows(db, companyKey, { activeOnly = true } = {}) {
  const snap = SNAPSHOTS[companyKey] || SNAPSHOTS.AI;
  const payload = safeReadJson(snap.gap_file);
  if (!payload) {
    return {
      ok: false,
      error: "CLAN_GAP_SNAPSHOT_MISSING",
      detail: `Place ${snap.gap_file} in the Josh project root (from Clan vs Product Master export).`,
      company: snap.company_key,
    };
  }
  const companyId = await resolveCompanyId(db, snap.company_key);
  if (!companyId) {
    return { ok: false, error: "COMPANY_NOT_FOUND", detail: `No company with code ${snap.company_key}.`, company: snap.company_key };
  }
  let source = Array.isArray(payload.missing_all) ? payload.missing_all : [];
  if (activeOnly) source = source.filter((row) => isActiveClan(row));
  const live = await loadLiveState(db, companyId);
  const seen = new Set();
  const rows = [];
  for (const row of source) {
    const code = normalizeCode(row.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const liveRow = live.get(code) || null;
    const { type, reason } = classify(row, liveRow);
    rows.push({
      item_code: String(row.code).trim(),
      item_name: row.name || "",
      category: row.category || "",
      group: row.group || "",
      item_type: row.itemType || "",
      clan_active: isActiveClan(row),
      product_id: liveRow?.id || null,
      exception_type: type,
      reason,
    });
  }
  return { ok: true, snap, payload, companyId, rows };
}

/**
 * Clan → Josh Product Master reconciliation for Product Master Desk.
 * Starts from the offline Clan_vs_ProductMaster_*.json export and classifies each
 * active Clan item against live products + company_product_policies.
 */
async function getClanProductMasterGapReport({ company = "AI", activeOnly = true, limit = 80, type = "" } = {}) {
  const key = String(company || "AI").trim().toUpperCase();
  const built = await buildClassifiedRows(pool, key, { activeOnly });
  if (!built.ok) return built;
  const { snap, payload, rows } = built;
  const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : {};

  const counts = { mapped: 0 };
  for (const t of EXCEPTION_TYPES) counts[t] = 0;
  for (const row of rows) counts[row.exception_type] = (counts[row.exception_type] || 0) + 1;
  const exceptions = rows.filter((row) => row.exception_type !== "mapped");
  const selectedType = EXCEPTION_TYPES.includes(type) ? type : "";
  const filtered = selectedType ? exceptions.filter((row) => row.exception_type === selectedType) : exceptions;

  const lim = Math.min(Math.max(Number(limit) || 80, 1), 500);
  return {
    ok: true,
    company: snap.company_key,
    company_label: snap.label,
    snapshot_file: snap.gap_file,
    snapshot_summary: {
      clan_unique_item_codes: summary.clan_unique_item_codes ?? null,
      matched: summary.matched_in_ai_product_master ?? summary.matched_in_at_product_master ?? null,
      missing_from_snapshot: summary.missing_from_ai_product_master ?? summary.missing_from_at_product_master ?? rows.length,
      coverage_pct: summary.coverage_pct_vs_ai ?? summary.coverage_pct_vs_at ?? null,
      missing_active_in_clan: summary.missing_active_in_clan ?? null,
      missing_by_category_top: summary.missing_by_category_top || summary.commercial_missing_by_category || [],
      clan_file: summary.clan_file || null,
      product_master_file: summary.product_master_file || null,
      compared_at: summary.compared_at || null,
    },
    counts,
    mappable_count: counts.not_in_josh + counts.no_company_policy,
    live_refresh: {
      active_only: Boolean(activeOnly),
      live_db_checked: true,
      snapshot_missing_rows: rows.length,
      still_missing_in_josh: counts.not_in_josh + counts.needs_review,
      now_present_in_josh: counts.mapped + counts.no_company_policy + counts.awaiting_tax,
    },
    exception_type: selectedType || "all",
    exceptions: filtered.slice(0, lim),
    exceptions_total: filtered.length,
    still_missing_sample: filtered.slice(0, lim),
    import_hint:
      "Map creates missing products inactive (HSN/GST are not in the Clan export) and adds this company's policy. Complete HSN and GST % in Product Master, then activate. Item codes stay frozen after create.",
  };
}

/**
 * Map active Clan items into Josh: create missing products (inactive until tax data is
 * completed) and add the missing company policy. Never touches an existing product's
 * item code, name, or tax fields.
 */
async function applyClanProductMapping({ company = "AI", itemCodes = null, all = false, actorUserId = null } = {}) {
  const key = String(company || "AI").trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const built = await buildClassifiedRows(client, key, { activeOnly: true });
    if (!built.ok) {
      await client.query("rollback");
      return built;
    }
    const { companyId, rows } = built;
    const wanted = all ? null : new Set((Array.isArray(itemCodes) ? itemCodes : []).map(normalizeCode).filter(Boolean));
    if (!all && !wanted.size) {
      await client.query("rollback");
      return { ok: false, error: "ITEM_CODES_REQUIRED" };
    }
    const result = { created_products: 0, added_policies: 0, skipped: [] };
    const categoryCache = new Map();
    const groupCache = new Map();

    async function categoryId(name) {
      const k = name.toLowerCase();
      if (categoryCache.has(k)) return categoryCache.get(k);
      let res = await client.query(`select id from product_categories where lower(trim(category_name)) = $1 limit 1`, [k]);
      if (!res.rows[0]) {
        res = await client.query(`insert into product_categories (category_name, is_active) values ($1, true) returning id`, [name]);
      }
      categoryCache.set(k, res.rows[0].id);
      return res.rows[0].id;
    }
    async function groupId(catId, name) {
      const k = `${catId}:${name.toLowerCase()}`;
      if (groupCache.has(k)) return groupCache.get(k);
      let res = await client.query(
        `select id from product_groups where category_id = $1 and lower(trim(group_name)) = $2 limit 1`,
        [catId, name.toLowerCase()]
      );
      if (!res.rows[0]) {
        res = await client.query(
          `insert into product_groups (category_id, group_name, is_active) values ($1, $2, true) returning id`,
          [catId, name]
        );
      }
      groupCache.set(k, res.rows[0].id);
      return res.rows[0].id;
    }

    for (const row of rows) {
      const code = normalizeCode(row.item_code);
      if (wanted && !wanted.has(code)) continue;
      if (!MAPPABLE_TYPES.has(row.exception_type)) {
        if (wanted) result.skipped.push({ item_code: row.item_code, exception_type: row.exception_type, reason: row.reason || "Already mapped" });
        continue;
      }
      let productId = row.product_id;
      if (row.exception_type === "not_in_josh") {
        const catId = await categoryId(String(row.category).trim());
        const grpId = await groupId(catId, String(row.group).trim());
        const ins = await client.query(
          `
            insert into products (
              category_id, group_id, item_code, item_name, item_type, uom, hsn_no,
              list_price, gst_pct, serial_no_required, is_active, is_auto_generated, is_manufactured,
              sku, standard_cost, selling_price, min_safety_stock, reorder_quantity, technical_notes
            )
            values ($1, $2, $3, $4, $5, 'Nos', null, 0, 0, false, false, false, false, $3, 0, 0, 0, 0, $6)
            on conflict (item_code) do nothing
            returning id
          `,
          [catId, grpId, String(row.item_code).trim(), String(row.item_name).trim(), row.item_type || null, CLAN_IMPORT_REMARK]
        );
        if (!ins.rows[0]) {
          result.skipped.push({ item_code: row.item_code, exception_type: row.exception_type, reason: "Item code created concurrently" });
          continue;
        }
        productId = ins.rows[0].id;
        result.created_products += 1;
      }
      const pol = await client.query(
        `
          insert into company_product_policies (company_id, product_id, sourcing_mode, is_saleable, is_purchaseable, is_stocked, remarks)
          values ($1, $2, 'buy_external', true, true, true, $3)
          on conflict (company_id, product_id) do nothing
          returning id
        `,
        [companyId, productId, `Mapped from Clan by user ${actorUserId || "system"}`]
      );
      if (pol.rows[0]) result.added_policies += 1;
    }
    await client.query("commit");
    return { ok: true, company: key, ...result };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getClanProductMasterGapReport,
  applyClanProductMapping,
  EXCEPTION_TYPES,
  SNAPSHOTS,
};
