#!/usr/bin/env node
/**
 * Import Sales/Commercial SO_Lines workbook for shell sales orders.
 *
 *   node scripts/import-sales-so-lines-workbook.js --company=AI --file=storage/filled.xlsx
 *   node scripts/import-sales-so-lines-workbook.js --company=AI --file=storage/filled.xlsx --apply
 *
 * Only writes lines onto SOs that currently have zero lines (unless --replace).
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = { apply: false, replace: false, company: "AI", file: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token === "--replace") out.replace = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--file=")) out.file = path.resolve(token.slice("--file=".length));
    if (token === "--file" && argv[i + 1]) out.file = path.resolve(argv[++i]);
  }
  return out;
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function clean(v) {
  return String(v ?? "").trim();
}

function num(v, fallback = 0) {
  if (v === "" || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

async function resolveProduct(client, _companyId, itemCode) {
  const code = clean(itemCode);
  if (!code) return null;
  const r = await client.query(
    `
      select id, item_code, item_name, hsn_no, gst_pct, uom
      from products
      where lower(trim(item_code)) = lower(trim($1))
      limit 1
    `,
    [code]
  );
  return r.rows[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !fs.existsSync(args.file)) {
    console.error(
      "Usage: node scripts/import-sales-so-lines-workbook.js --company=AI --file=... [--apply] [--replace]"
    );
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const wb = XLSX.readFile(args.file);
  const rawLines = sheetRows(wb, "SO_Lines")
    .map((row, idx) => ({
      _row: idx + 2,
      so_number: clean(row.so_number),
      line_no: num(row.line_no, 0),
      item_code: clean(row.item_code),
      item_name: clean(row.item_name),
      line_description: clean(row.line_description),
      hsn_no: clean(row.hsn_no),
      qty: num(row.qty, 0),
      unit_price: num(row.unit_price, NaN),
      gst_pct: num(row.gst_pct, 18),
      uom: clean(row.uom) || "NOS",
    }))
    .filter((r) => r.so_number && (r.item_name || r.item_code) && r.qty > 0 && Number.isFinite(r.unit_price));

  const bySo = new Map();
  for (const line of rawLines) {
    if (!bySo.has(line.so_number)) bySo.set(line.so_number, []);
    bySo.get(line.so_number).push(line);
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "APPLY" : "DRY_RUN",
        replace: args.replace,
        company: args.company,
        file: args.file,
        line_rows: rawLines.length,
        sales_orders: bySo.size,
        sample: rawLines.slice(0, 20),
      },
      null,
      2
    )
  );

  if (!args.apply) {
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    await client.query("begin");
    const results = [];

    for (const [soNumber, lines] of bySo.entries()) {
      const soRes = await client.query(
        `
          select so.id, so.so_number,
            (select count(*)::int from sales_order_lines sol where sol.sales_order_id = so.id) as line_count
          from sales_orders so
          where so.company_id = $1 and lower(trim(so.so_number)) = lower(trim($2))
          limit 1
        `,
        [company.id, soNumber]
      );
      const so = soRes.rows[0];
      if (!so) {
        results.push({ ok: false, reason: "SO_NOT_FOUND", so_number: soNumber });
        continue;
      }
      if (so.line_count > 0 && !args.replace) {
        results.push({
          ok: false,
          reason: "SO_ALREADY_HAS_LINES",
          so_number: soNumber,
          line_count: so.line_count,
        });
        continue;
      }

      if (args.replace && so.line_count > 0) {
        await client.query(`delete from sales_order_lines where sales_order_id = $1`, [so.id]);
      }

      const drafts = [];
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        const product = await resolveProduct(client, company.id, line.item_code);
        const unit = money(line.unit_price);
        const qty = Number(line.qty);
        const lineTotal = money(qty * unit);
        drafts.push({
          line_no: line.line_no > 0 ? line.line_no : lineNo,
          product_id: product?.id || null,
          item_code: line.item_code || product?.item_code || null,
          item_name: line.item_name || product?.item_name || line.item_code || `Line ${lineNo}`,
          line_description: line.line_description || line.item_name || product?.item_name || null,
          hsn_no: line.hsn_no || product?.hsn_no || null,
          qty,
          unit_price_base: unit,
          unit_price_order: unit,
          gst_pct: line.gst_pct != null ? Number(line.gst_pct) : Number(product?.gst_pct || 18),
          line_total_base: lineTotal,
          line_total_order: lineTotal,
          uom: line.uom || product?.uom || "NOS",
        });
      }

      for (const d of drafts) {
        await client.query(
          `
            insert into sales_order_lines (
              sales_order_id, line_no, product_id, item_code, item_name, line_description, hsn_no,
              qty, unit_price_base, unit_price_order, gst_pct, line_total_base, line_total_order, uom
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          `,
          [
            so.id,
            d.line_no,
            d.product_id,
            d.item_code,
            d.item_name,
            d.line_description,
            d.hsn_no,
            d.qty,
            d.unit_price_base,
            d.unit_price_order,
            d.gst_pct,
            d.line_total_base,
            d.line_total_order,
            d.uom,
          ]
        );
      }

      const subtotal = money(drafts.reduce((s, d) => s + d.line_total_order, 0));
      const tax = money(drafts.reduce((s, d) => s + (d.line_total_order * d.gst_pct) / 100, 0));
      const grand = money(subtotal + tax);

      await client.query(
        `
          update sales_orders
          set
            subtotal_base = $2,
            subtotal_order = $2,
            tax_total_base = $3,
            tax_total_order = $3,
            grand_total_base = $4,
            grand_total_order = $4,
            updated_at = now()
          where id = $1
        `,
        [so.id, subtotal, tax, grand]
      );

      results.push({
        ok: true,
        so_number: so.so_number,
        line_count: drafts.length,
        grand_total_order: grand,
      });
    }

    await client.query("commit");
    console.log(
      JSON.stringify(
        {
          ok: true,
          applied: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          failures: results.filter((r) => !r.ok).slice(0, 50),
          sample_ok: results.filter((r) => r.ok).slice(0, 20),
        },
        null,
        2
      )
    );
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
