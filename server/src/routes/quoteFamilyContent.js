const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { FAMILY_BROCHURE_CONTENT } = require("../pdf/quoteFamilyBrochureContent");

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
});

const EDITABLE_KEYS = Object.keys(FAMILY_BROCHURE_CONTENT);

async function tableReady(client) {
  const r = await client.query(`select to_regclass('public.quote_family_content') is not null as ready`);
  return r.rows[0]?.ready === true;
}

function builtInEntry(key) {
  const entry = FAMILY_BROCHURE_CONTENT[key] || {};
  return {
    title: entry.title || "",
    tagline: entry.tagline || "",
    source_url: entry.source_url || "",
    write_up: entry.write_up || "",
    unique_features: Array.isArray(entry.unique_features) ? entry.unique_features : [],
    design_rows: Array.isArray(entry.ambient_design) ? entry.ambient_design : [],
  };
}

function cleanText(value, max) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function cleanList(value) {
  const list = (Array.isArray(value) ? value : []).map((x) => String(x || "").trim().slice(0, 500)).filter(Boolean);
  return list.length ? list.slice(0, 30) : null;
}

function cleanRows(value) {
  const rows = (Array.isArray(value) ? value : [])
    .map((row) => ({ label: String(row?.label || "").trim().slice(0, 120), value: String(row?.value || "").trim().slice(0, 500) }))
    .filter((row) => row.label && row.value);
  return rows.length ? rows.slice(0, 40) : null;
}

function jsonOrNull(value) {
  return value ? JSON.stringify(value) : null;
}

router.get("/", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const ready = await tableReady(pool);
    const saved = ready ? (await pool.query(`select * from quote_family_content`)).rows : [];
    const byKey = new Map(saved.map((row) => [row.content_key, row]));
    const families = EDITABLE_KEYS.map((key) => {
      const row = byKey.get(key) || null;
      return {
        content_key: key,
        family_name: FAMILY_BROCHURE_CONTENT[key]?.family_name || key,
        built_in: builtInEntry(key),
        saved: row
          ? {
              title: row.title,
              tagline: row.tagline,
              source_url: row.source_url,
              write_up: row.write_up,
              unique_features: row.unique_features,
              design_rows: row.design_rows,
              is_active: row.is_active,
              updated_at: row.updated_at,
              updated_by: row.updated_by,
            }
          : null,
      };
    });
    return res.json({ ok: true, ready, can_edit: hasScreenAction(req, "quote_write_ups", "can_edit"), families });
  } catch (err) {
    return next(err);
  }
});

router.put("/:key", requireScreenAction("quote_write_ups", "can_edit"), async (req, res, next) => {
  try {
    const key = String(req.params.key || "").trim().toUpperCase();
    if (!EDITABLE_KEYS.includes(key)) return res.status(404).json({ ok: false, error: "UNKNOWN_FAMILY" });
    if (!(await tableReady(pool))) return res.status(409).json({ ok: false, error: "MIGRATION_PENDING" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const r = await pool.query(
      `
        insert into quote_family_content (content_key, title, tagline, source_url, write_up, unique_features, design_rows, is_active, updated_by, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,true,$8,now())
        on conflict (content_key) do update set
          title = excluded.title,
          tagline = excluded.tagline,
          source_url = excluded.source_url,
          write_up = excluded.write_up,
          unique_features = excluded.unique_features,
          design_rows = excluded.design_rows,
          is_active = true,
          updated_by = excluded.updated_by,
          updated_at = now()
        returning *
      `,
      [
        key,
        cleanText(body.title, 200),
        cleanText(body.tagline, 300),
        cleanText(body.source_url, 500),
        cleanText(body.write_up, 5000),
        jsonOrNull(cleanList(body.unique_features)),
        jsonOrNull(cleanRows(body.design_rows)),
        req.user.id,
      ]
    );
    return res.json({ ok: true, saved: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete("/:key", requireScreenAction("quote_write_ups", "can_edit"), async (req, res, next) => {
  try {
    const key = String(req.params.key || "").trim().toUpperCase();
    if (!EDITABLE_KEYS.includes(key)) return res.status(404).json({ ok: false, error: "UNKNOWN_FAMILY" });
    if (!(await tableReady(pool))) return res.json({ ok: true });
    await pool.query(`delete from quote_family_content where content_key = $1`, [key]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
