#!/usr/bin/env node
/**
 * Delete one sales order by so_number (safe guards for linked commercial docs).
 *
 *   node scripts/delete-sales-order.js --so=SO/26-27/000001
 *   node scripts/delete-sales-order.js --so=SO/26-27/000001 --company=AI --apply
 *
 * Refuses if invoices, dispatches, or live proformas exist (ON DELETE CASCADE would wipe them).
 * Optional: --unlink-invoices  (nulls customer_invoices.sales_order_id, still refuses dispatches)
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");

function parseArgs(argv) {
  const out = {
    apply: false,
    company: "AI",
    so: "",
    unlinkInvoices: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token === "--unlink-invoices") out.unlinkInvoices = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--so=")) out.so = token.slice("--so=".length).trim();
    if (token === "--so" && argv[i + 1]) out.so = String(argv[++i]).trim();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.so) {
    console.error("Usage: node scripts/delete-sales-order.js --so=SO/26-27/000001 [--company=AI] [--apply]");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const companyRes = await client.query(
      `select id, company_code from companies where lower(company_code) = lower($1) limit 1`,
      [args.company]
    );
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const soRes = await client.query(
      `
        select
          so.id, so.so_number, so.company_id, so.order_status, so.customer_id, so.job_no,
          so.quote_revision_id, so.grand_total_order, so.created_at,
          c.customer_name, c.customer_code
        from sales_orders so
        left join customers c on c.id = so.customer_id
        where so.company_id = $1
          and lower(trim(so.so_number)) = lower(trim($2))
        limit 1
      `,
      [company.id, args.so]
    );
    const so = soRes.rows[0];
    if (!so) {
      console.log(JSON.stringify({ ok: false, error: "NOT_FOUND", so_number: args.so, company: company.company_code }, null, 2));
      process.exitCode = 1;
      return;
    }

    const [inv, disp, pf, lines, miles, jobs, site] = await Promise.all([
      client.query(
        `select id, invoice_number, invoice_status, grand_total_invoice
         from customer_invoices where sales_order_id = $1 order by id`,
        [so.id]
      ),
      client.query(
        `select id, dispatch_number, dispatch_status
         from dispatches where sales_order_id = $1 order by id`,
        [so.id]
      ),
      client.query(
        `select id, proforma_number, proforma_status
         from proforma_invoices where sales_order_id = $1 order by id`,
        [so.id]
      ),
      client.query(`select count(*)::int as n from sales_order_lines where sales_order_id = $1`, [so.id]),
      client.query(`select count(*)::int as n from payment_milestones where sales_order_id = $1`, [so.id]),
      client.query(
        `select id, job_number, job_status from job_cards where sales_order_id = $1 order by id limit 20`,
        [so.id]
      ).catch(() => ({ rows: [] })),
      client.query(
        `select id, status from site_readiness_checklists where sales_order_id = $1 order by id limit 20`,
        [so.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const blockers = [];
    if (disp.rows.length) blockers.push({ type: "dispatches", count: disp.rows.length, rows: disp.rows });
    const liveProformas = pf.rows.filter(
      (row) => !["cancelled", "expired"].includes(String(row.proforma_status || "").toLowerCase())
    );
    if (liveProformas.length) blockers.push({ type: "proforma_invoices", count: liveProformas.length, rows: liveProformas });
    if (inv.rows.length && !args.unlinkInvoices) {
      blockers.push({
        type: "customer_invoices",
        count: inv.rows.length,
        rows: inv.rows,
        hint: "Pass --unlink-invoices to null sales_order_id on invoices, then delete SO (still refuses if dispatches exist).",
      });
    }

    const report = {
      mode: args.apply ? "APPLY" : "DRY_RUN",
      company: company.company_code,
      sales_order: so,
      linked: {
        invoice_count: inv.rows.length,
        invoices: inv.rows,
        dispatch_count: disp.rows.length,
        dispatches: disp.rows,
        proforma_count: pf.rows.length,
        proformas: pf.rows,
        line_count: lines.rows[0]?.n || 0,
        milestone_count: miles.rows[0]?.n || 0,
        job_cards: jobs.rows,
        site_readiness: site.rows,
      },
      blockers,
    };

    if (blockers.length) {
      console.log(JSON.stringify({ ok: false, error: "HAS_LINKED_DOCUMENTS", ...report }, null, 2));
      process.exitCode = 1;
      return;
    }

    if (!args.apply) {
      console.log(JSON.stringify({ ok: true, would_delete: true, ...report }, null, 2));
      return;
    }

    await client.query("begin");
    if (inv.rows.length && args.unlinkInvoices) {
      await client.query(`update customer_invoices set sales_order_id = null, updated_at = now() where sales_order_id = $1`, [
        so.id,
      ]);
    }
    // Null optional FKs that might still restrict in some environments
    await client.query(`update job_cards set sales_order_id = null where sales_order_id = $1`, [so.id]).catch(() => null);
    await client.query(`update leads set converted_sales_order_id = null where converted_sales_order_id = $1`, [so.id]).catch(
      () => null
    );

    const del = await client.query(`delete from sales_orders where id = $1 returning id, so_number`, [so.id]);
    await client.query("commit");

    console.log(
      JSON.stringify(
        {
          ok: true,
          deleted: del.rows[0] || null,
          unlinked_invoices: args.unlinkInvoices ? inv.rows.length : 0,
          mode: "APPLY",
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
