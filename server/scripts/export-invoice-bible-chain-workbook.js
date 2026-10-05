#!/usr/bin/env node
/**
 * Invoice-bible O2C workbook (Absstem).
 *
 * Design: Tally invoices (already in Josh) are the source of truth.
 * Export is item-wise (one row per invoice line). Sales fills SO / Job serial /
 * Dispatch refs against those rows — never invent invoice amounts in Excel.
 *
 * Blank template (column layout + examples only):
 *   node scripts/export-invoice-bible-chain-workbook.js --blank
 *
 * Live export from Josh (recommended):
 *   node scripts/export-invoice-bible-chain-workbook.js --company=AI
 *   node scripts/export-invoice-bible-chain-workbook.js --company=AI --out-dir=storage
 *
 * Later import (fill columns only) — use existing chain/job importers, or a
 * dedicated importer when wired:
 *   so_number / job_no / dispatch_number on Invoice_Lines_Fill
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function parseArgs(argv) {
  const out = {
    company: "AI",
    outDir: path.resolve(__dirname, "../storage"),
    blank: false,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--blank") out.blank = true;
    else if (token.startsWith("--company=")) out.company = token.slice("--company=".length);
    else if (token === "--company" && argv[i + 1]) out.company = argv[++i];
    else if (token.startsWith("--out-dir=")) out.outDir = path.resolve(token.slice("--out-dir=".length));
    else if (token === "--out-dir" && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
    else if (token.startsWith("--limit=")) out.limit = Number(token.slice("--limit=".length)) || 0;
  }
  return out;
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function writeBook(outPath, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows, aoa } of sheets) {
    const ws = aoa ? XLSX.utils.aoa_to_sheet(aoa) : XLSX.utils.json_to_sheet(rows || []);
    if (rows?.length) {
      const cols = Object.keys(rows[0] || {});
      ws["!cols"] = cols.map((key) => ({
        wch: Math.min(36, Math.max(12, String(key).length + 2)),
      }));
    }
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);
  return outPath;
}

function instructionsAoa(companyCode, mode) {
  return [
    ["Josh — Invoice Bible O2C Chain Workbook"],
    [`Company: ${companyCode || "AI"}`],
    [`Mode: ${mode}`],
    [""],
    ["Principle"],
    ["1. Tally invoices already imported into Josh are the BIBLE (amounts, items, parties, dates)."],
    ["2. Do NOT re-type invoice totals or invent invoice lines in Excel."],
    ["3. Fill only the yellow/fill columns: SO number, Job/machine serial, Dispatch refs, Customer PO."],
    ["4. One row = one invoice LINE (item-wise). Header fields repeat on each line of the same invoice."],
    [""],
    ["Sheets"],
    ["Instructions — this page"],
    ["Invoice_Lines_Bible — READ-ONLY reference from Josh/Tally (item-wise)"],
    ["Invoice_Lines_Fill — same keys + columns YOU fill (so_number, job_no, dispatch_*)"],
    ["SO_Dispatch_Hints — optional summary: unique SO / Job / Dispatch to create or link"],
    ["_Example — sample row shapes (do not import)"],
    [""],
    ["Fill columns (on Invoice_Lines_Fill)"],
    ["so_number — Josh/legacy SO to link (e.g. S26000073). Leave blank if unknown."],
    ["job_no — Absstem machine serial (e.g. N047). Multi-machine: N111,N112"],
    ["dispatch_number — existing or planned dispatch doc no (optional)"],
    ["dispatch_date — YYYY-MM-DD or DD-Mon-YYYY"],
    ["customer_po_number / customer_po_date — buyer PO if missing on SO/invoice"],
    ["notes — free text"],
    [""],
    ["Do not change (Bible columns)"],
    ["invoice_number, invoice_date, customer_*, line_no, item_*, qty, rates, tax, totals"],
    [""],
    ["Why not rebuild SO→Invoice from scratch?"],
    ["Invoice GL/AR already posted from Tally. Re-creating invoices would double-count books."],
    ["This workbook only attaches commercial refs (SO / Job / Dispatch) onto the Tally truth."],
    [""],
    ["Suggested workflow"],
    ["A) Export live: node scripts/export-invoice-bible-chain-workbook.js --company=AI"],
    ["B) Sales fills so_number + job_no (+ dispatch if known) on Invoice_Lines_Fill"],
    ["C) Import map: existing Invoice_SO_Map / job_no importers (or dedicated importer next)"],
    ["D) Installed Equipment / Job Assets can be seeded from filled job_no later"],
  ];
}

function bibleColumns() {
  return {
    company_code: "",
    invoice_id: "",
    invoice_number: "",
    tally_voucher_number: "",
    invoice_date: "",
    invoice_status: "",
    customer_code: "",
    customer_name: "",
    line_id: "",
    line_no: "",
    item_code: "",
    item_name: "",
    hsn_no: "",
    qty: "",
    uom: "",
    unit_price: "",
    line_subtotal: "",
    gst_pct: "",
    line_tax: "",
    line_total: "",
    invoice_grand_total: "",
    linked_so_number: "",
    linked_job_no: "",
    linked_dispatch_number: "",
    linked_customer_po: "",
  };
}

function fillColumns() {
  return {
    invoice_number: "",
    line_no: "",
    item_code: "",
    item_name: "",
    qty: "",
    // fill
    so_number: "",
    job_no: "",
    dispatch_number: "",
    dispatch_date: "",
    customer_po_number: "",
    customer_po_date: "",
    notes: "",
    // echo bible link state
    linked_so_number: "",
    linked_job_no: "",
    linked_dispatch_number: "",
  };
}

function exampleRows() {
  return [
    {
      ...fillColumns(),
      invoice_number: "AI/26-27/0142",
      line_no: 1,
      item_code: "NITROGEN-GEN",
      item_name: "Nitrogen Generator",
      qty: 1,
      so_number: "S26000073",
      job_no: "N047",
      dispatch_number: "DSP/26-27/0088",
      dispatch_date: "2026-06-15",
      customer_po_number: "PO-8891",
      customer_po_date: "2026-05-20",
      notes: "Example only — Subros / N047",
      linked_so_number: "",
      linked_job_no: "",
      linked_dispatch_number: "",
    },
    {
      ...fillColumns(),
      invoice_number: "AI/26-27/0201",
      line_no: 1,
      item_code: "NITROGEN-GEN",
      item_name: "Nitrogen Generator",
      qty: 1,
      so_number: "S26000068",
      job_no: "N111",
      notes: "Multi-machine SO: put same so_number on each line; job_no per machine line",
    },
    {
      ...fillColumns(),
      invoice_number: "AI/26-27/0201",
      line_no: 2,
      item_code: "NITROGEN-GEN",
      item_name: "Nitrogen Generator",
      qty: 1,
      so_number: "S26000068",
      job_no: "N112",
      notes: "2nd machine on same invoice / SO",
    },
  ];
}

async function exportLive(args) {
  const { pool } = require("../src/db/pool");
  const { resolveCompanyId } = require("../src/services/o2cChainRepair");
  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const limitSql = args.limit > 0 ? `limit ${Math.trunc(args.limit)}` : "";
    const r = await client.query(
      `
        select
          co.company_code,
          ci.id as invoice_id,
          ci.invoice_number,
          ci.tally_voucher_number,
          ci.invoice_date::date::text as invoice_date,
          ci.invoice_status,
          c.customer_code,
          c.customer_name,
          il.id as line_id,
          il.line_no,
          il.item_code,
          il.item_name,
          il.hsn_no,
          il.qty,
          ''::text as uom,
          coalesce(il.unit_price_invoice, il.unit_price_base) as unit_price,
          il.line_total_base as line_subtotal,
          il.gst_pct,
          case
            when coalesce(il.gst_pct, 0) > 0
              then round(coalesce(il.line_total_base, 0) * coalesce(il.gst_pct, 0) / 100.0, 2)
            else 0
          end as line_tax,
          coalesce(il.line_total_invoice, il.line_total_base) as line_total,
          ci.grand_total_invoice as invoice_grand_total,
          so.so_number as linked_so_number,
          coalesce(ci.job_no, so.job_no) as linked_job_no,
          d.dispatch_number as linked_dispatch_number,
          coalesce(ci.customer_po_number, so.customer_po_number, so.buyer_po_number) as linked_customer_po
        from customer_invoices ci
        join companies co on co.id = ci.company_id
        left join customers c on c.id = ci.customer_id
        left join invoice_lines il on il.customer_invoice_id = ci.id
        left join sales_orders so on so.id = ci.sales_order_id
        left join dispatches d on d.id = ci.dispatch_id
        where ci.company_id = $1
          and ci.invoice_status <> 'cancelled'
        order by ci.invoice_date desc nulls last, ci.id desc, il.line_no asc nulls last, il.id asc
        ${limitSql}
      `,
      [company.id]
    );

    const bible = r.rows.map((row) => ({
      company_code: row.company_code,
      invoice_id: row.invoice_id,
      invoice_number: row.invoice_number,
      tally_voucher_number: row.tally_voucher_number || "",
      invoice_date: row.invoice_date || "",
      invoice_status: row.invoice_status || "",
      customer_code: row.customer_code || "",
      customer_name: row.customer_name || "",
      line_id: row.line_id || "",
      line_no: row.line_no ?? "",
      item_code: row.item_code || "",
      item_name: row.item_name || "",
      hsn_no: row.hsn_no || "",
      qty: row.qty != null ? Number(row.qty) : "",
      uom: row.uom || "",
      unit_price: row.unit_price != null ? money(row.unit_price) : "",
      line_subtotal: row.line_subtotal != null ? money(row.line_subtotal) : "",
      gst_pct: row.gst_pct != null ? Number(row.gst_pct) : "",
      line_tax: row.line_tax != null ? money(row.line_tax) : "",
      line_total: row.line_total != null ? money(row.line_total) : "",
      invoice_grand_total: row.invoice_grand_total != null ? money(row.invoice_grand_total) : "",
      linked_so_number: row.linked_so_number || "",
      linked_job_no: row.linked_job_no || "",
      linked_dispatch_number: row.linked_dispatch_number || "",
      linked_customer_po: row.linked_customer_po || "",
    }));

    // If invoice has no lines yet, still emit a header-only bible row
    const fill = bible.map((row) => ({
      invoice_number: row.invoice_number,
      line_no: row.line_no,
      item_code: row.item_code,
      item_name: row.item_name,
      qty: row.qty,
      so_number: row.linked_so_number || "",
      job_no: row.linked_job_no || "",
      dispatch_number: row.linked_dispatch_number || "",
      dispatch_date: "",
      customer_po_number: row.linked_customer_po || "",
      customer_po_date: "",
      notes: "",
      linked_so_number: row.linked_so_number || "",
      linked_job_no: row.linked_job_no || "",
      linked_dispatch_number: row.linked_dispatch_number || "",
    }));

    const hintMap = new Map();
    for (const row of fill) {
      const key = `${row.so_number || ""}|${row.job_no || ""}|${row.invoice_number}`;
      if (!hintMap.has(key)) {
        hintMap.set(key, {
          invoice_number: row.invoice_number,
          so_number: row.so_number,
          job_no: row.job_no,
          dispatch_number: row.dispatch_number,
          customer_name: bible.find((b) => b.invoice_number === row.invoice_number)?.customer_name || "",
          needs_so_link: row.linked_so_number ? "no" : "yes",
          needs_job_no: row.linked_job_no ? "no" : "yes",
        });
      }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = path.join(args.outDir, `${company.company_code}-Invoice-Bible-O2C-${stamp}.xlsx`);

    const invCount = await client.query(
      `
        select
          count(*)::int as invoices,
          count(*) filter (where exists (
            select 1 from invoice_lines il where il.customer_invoice_id = ci.id
          ))::int as invoices_with_lines,
          (select count(*)::int from invoice_lines il
             join customer_invoices ci2 on ci2.id = il.customer_invoice_id
            where ci2.company_id = $1 and ci2.invoice_status <> 'cancelled') as line_rows
        from customer_invoices ci
        where ci.company_id = $1
          and ci.invoice_status <> 'cancelled'
      `,
      [company.id]
    );
    const stats = invCount.rows[0] || {};

    if (!bible.length) {
      bible.push({
        ...bibleColumns(),
        company_code: company.company_code,
        invoice_number: "*** NO INVOICES FOUND ***",
        item_name: "Check company_id / Tally sales invoice import for this company",
      });
      fill.push({
        ...fillColumns(),
        invoice_number: "*** NO INVOICES FOUND ***",
        item_name: "Import Tally sales invoices first, then re-export",
      });
    }

    const missingLines = Number(stats.invoices || 0) - Number(stats.invoices_with_lines || 0);
    if (missingLines > 0) {
      bible.unshift({
        ...bibleColumns(),
        company_code: company.company_code,
        invoice_number: `*** NOTE: ${missingLines} invoices have HEADER ONLY (no invoice_lines) ***`,
        item_name:
          "Re-import/repair Tally inventory lines, or fill Job/SO at invoice header level using Invoice_Lines_Fill rows that have blank line_no",
      });
    }

    writeBook(outPath, [
      {
        name: "Instructions",
        aoa: [
          ...instructionsAoa(company.company_code, "LIVE export from Josh (Tally invoices)"),
          [""],
          ["Export stats"],
          [`Invoices: ${stats.invoices || 0}`],
          [`Invoices with lines: ${stats.invoices_with_lines || 0}`],
          [`Invoice line rows: ${stats.line_rows || 0}`],
          [`Exported bible rows: ${bible.length}`],
        ],
      },
      { name: "Invoice_Lines_Bible", rows: bible },
      { name: "Invoice_Lines_Fill", rows: fill.length ? fill : [fillColumns()] },
      { name: "SO_Dispatch_Hints", rows: [...hintMap.values()] },
      { name: "_Example", rows: exampleRows() },
    ]);
    return {
      outPath,
      bibleRows: bible.length,
      company: company.company_code,
      invoices: Number(stats.invoices || 0),
      withLines: Number(stats.invoices_with_lines || 0),
      lineRows: Number(stats.line_rows || 0),
    };
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

function exportBlank(args) {
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(args.outDir, `AI-Invoice-Bible-O2C-TEMPLATE-${stamp}.xlsx`);
  const emptyNotice = {
    ...bibleColumns(),
    company_code: "AI",
    invoice_number: "*** BLANK TEMPLATE — NO TALLY DATA ***",
    item_name:
      "Run LIVE export on prod: node scripts/export-invoice-bible-chain-workbook.js --company=AI",
    notes: "",
  };
  // bibleColumns has no notes — keep shape
  writeBook(outPath, [
    {
      name: "Instructions",
      aoa: [
        ...instructionsAoa("AI", "BLANK template — headers only; invoice lines come from LIVE export"),
        [""],
        ["IMPORTANT"],
        ["This blank file intentionally has EMPTY invoice lines."],
        ["Tally invoice lines live in Josh DB after Tally import — export them with:"],
        ["  docker exec josh-api node scripts/export-invoice-bible-chain-workbook.js --company=AI"],
        ["Then download the dated file from /app/server/storage/"],
      ],
    },
    { name: "Invoice_Lines_Bible", rows: [emptyNotice] },
    {
      name: "Invoice_Lines_Fill",
      rows: [
        {
          ...fillColumns(),
          invoice_number: "*** RUN LIVE EXPORT ***",
          item_name: "Blank template has no invoice lines. Export from Josh/Tally first.",
        },
      ],
    },
    {
      name: "SO_Dispatch_Hints",
      rows: [
        {
          invoice_number: "",
          so_number: "",
          job_no: "",
          dispatch_number: "",
          customer_name: "",
          needs_so_link: "",
          needs_job_no: "",
        },
      ],
    },
    { name: "_Example", rows: exampleRows() },
  ]);
  return { outPath, bibleRows: 0, company: "AI", invoices: 0, withLines: 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const result = args.blank ? exportBlank(args) : await exportLive(args);
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: result.outPath,
        company: result.company,
        invoices: result.invoices ?? null,
        invoices_with_lines: result.withLines ?? null,
        invoice_line_rows: result.lineRows ?? null,
        bible_rows: result.bibleRows,
        note: args.blank
          ? "Blank template has NO invoice lines by design. Run without --blank on prod to pull Tally lines from Josh."
          : "Tally invoices = bible. Fill so_number / job_no / dispatch on Invoice_Lines_Fill only.",
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
