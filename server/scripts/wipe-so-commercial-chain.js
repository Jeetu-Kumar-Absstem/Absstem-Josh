#!/usr/bin/env node
/**
 * Wipe an SO commercial chain: quote → SO → proformas → invoice (+ receipt links).
 *
 * Dry-run:
 *   node scripts/wipe-so-commercial-chain.js --so=SO/26-27/000001 --company=AI
 *
 * Apply (requires matching confirm):
 *   node scripts/wipe-so-commercial-chain.js --so=SO/26-27/000001 --company=AI \
 *     --confirm=SO/26-27/000001 --apply
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");

function parseArgs(argv) {
  const out = { apply: false, company: "AI", so: "", confirm: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--so=")) out.so = token.slice("--so=".length).trim();
    if (token === "--so" && argv[i + 1]) out.so = String(argv[++i]).trim();
    if (token.startsWith("--confirm=")) out.confirm = token.slice("--confirm=".length).trim();
    if (token === "--confirm" && argv[i + 1]) out.confirm = String(argv[++i]).trim();
  }
  return out;
}

async function q(client, sql, params = []) {
  return client.query(sql, params);
}

async function tryQ(client, sql, params = [], { inTransaction = false } = {}) {
  const run = async () => {
    try {
      return await client.query(sql, params);
    } catch (err) {
      if (
        err?.code === "42P01" ||
        err?.code === "42703" ||
        err?.code === "23503" ||
        err?.code === "42883"
      ) {
        return { rows: [], rowCount: 0, skipped: true, error: err.message, code: err.code };
      }
      throw err;
    }
  };

  // Outside a TX, a failed query does not poison later commands.
  if (!inTransaction) return run();

  // Inside a TX, Postgres aborts the whole TX on any error — use SAVEPOINT.
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const result = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch {
      /* ignore */
    }
    if (
      err?.code === "42P01" ||
      err?.code === "42703" ||
      err?.code === "23503" ||
      err?.code === "42883"
    ) {
      return { rows: [], rowCount: 0, skipped: true, error: err.message, code: err.code };
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.so) {
    console.error("Usage: node scripts/wipe-so-commercial-chain.js --so=SO/26-27/000001 --company=AI [--confirm=SO/26-27/000001 --apply]");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const companyRes = await q(
      client,
      `select id, company_code from companies where lower(company_code) = lower($1) limit 1`,
      [args.company]
    );
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const soRes = await q(
      client,
      `
        select
          so.id, so.so_number, so.company_id, so.order_status, so.customer_id,
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
      console.log(JSON.stringify({ ok: false, error: "SO_NOT_FOUND", so_number: args.so, company: company.company_code }, null, 2));
      process.exitCode = 1;
      return;
    }

    let quote = null;
    if (so.quote_revision_id) {
      const qr = await q(
        client,
        `
          select
            qr.id as quote_revision_id,
            qr.revision_no,
            qr.revision_status,
            qh.id as quote_id,
            qh.quote_number,
            qh.quote_status
          from quote_revisions qr
          join quote_headers qh on qh.id = qr.quote_id
          where qr.id = $1
          limit 1
        `,
        [so.quote_revision_id]
      );
      quote = qr.rows[0] || null;
    }

    const invoices = (
      await q(
        client,
        `select id, invoice_number, invoice_status, grand_total_invoice, sales_order_id
         from customer_invoices
         where company_id = $1 and (sales_order_id = $2 or id in (
           select converted_invoice_id from proforma_invoices where sales_order_id = $2 and converted_invoice_id is not null
         ))
         order by id`,
        [company.id, so.id]
      )
    ).rows;

    // Also catch invoice by number pattern if linked only via number coincidence — stick to SO id.
    const invoiceIds = invoices.map((r) => Number(r.id));

    const proformas = (
      await q(
        client,
        `select id, proforma_number, proforma_status, payment_milestone_id, converted_invoice_id
         from proforma_invoices where sales_order_id = $1 order by id`,
        [so.id]
      )
    ).rows;

    const dispatches = (
      await q(
        client,
        `select id, dispatch_number, dispatch_status from dispatches where sales_order_id = $1 order by id`,
        [so.id]
      )
    ).rows;

    const milestones = (
      await q(client, `select id, milestone_name, status from payment_milestones where sales_order_id = $1 order by id`, [so.id])
    ).rows;

    const lines = (await q(client, `select count(*)::int as n from sales_order_lines where sales_order_id = $1`, [so.id])).rows[0]?.n || 0;

    let allocs = [];
    if (invoiceIds.length) {
      allocs = (
        await tryQ(
          client,
          `select id, customer_receipt_id, customer_invoice_id, allocated_invoice
           from customer_receipt_allocations
           where customer_invoice_id = any($1::int[])
           order by id`,
          [invoiceIds]
        )
      ).rows;
    }

    let arAdjustments = [];
    let disputes = [];
    let collectionActions = [];
    if (invoiceIds.length) {
      arAdjustments = (
        await tryQ(client, `select id from customer_ar_adjustments where customer_invoice_id = any($1::int[])`, [invoiceIds])
      ).rows;
      disputes = (
        await tryQ(client, `select id from customer_collection_disputes where customer_invoice_id = any($1::int[])`, [invoiceIds])
      ).rows;
      collectionActions = (
        await tryQ(client, `select id from customer_collection_actions where customer_invoice_id = any($1::int[])`, [invoiceIds])
      ).rows;
    }

    const plan = {
      mode: args.apply ? "APPLY" : "DRY_RUN",
      company: company.company_code,
      sales_order: so,
      quote,
      invoices,
      proformas,
      dispatches,
      milestones,
      so_line_count: lines,
      receipt_allocations: allocs,
      ar_adjustments: arAdjustments.length,
      collection_disputes: disputes.length,
      collection_actions: collectionActions.length,
      will_delete: {
        quote_header: quote?.quote_id || null,
        quote_number: quote?.quote_number || null,
        sales_order_id: so.id,
        so_number: so.so_number,
        proforma_ids: proformas.map((p) => p.id),
        invoice_ids: invoiceIds,
        dispatch_ids: dispatches.map((d) => d.id),
      },
    };

    if (!args.apply) {
      console.log(JSON.stringify({ ok: true, would_wipe: true, ...plan }, null, 2));
      return;
    }

    if (String(args.confirm || "").trim() !== String(args.so).trim()) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: "CONFIRM_REQUIRED",
            detail: `Pass --confirm=${args.so} to apply full wipe.`,
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      return;
    }

    await q(client, "begin");
    const tx = { inTransaction: true };
    const deleted = {};

    // 1) Receipt allocations → then orphan receipts that only pointed here
    if (invoiceIds.length) {
      const receiptIds = [...new Set(allocs.map((a) => Number(a.customer_receipt_id)).filter((n) => n > 0))];
      deleted.receipt_allocations = (
        await tryQ(
          client,
          `delete from customer_receipt_allocations where customer_invoice_id = any($1::int[])`,
          [invoiceIds],
          tx
        )
      ).rowCount;
      deleted.collection_actions = (
        await tryQ(
          client,
          `delete from customer_collection_actions where customer_invoice_id = any($1::int[])`,
          [invoiceIds],
          tx
        )
      ).rowCount;
      deleted.collection_disputes = (
        await tryQ(
          client,
          `delete from customer_collection_disputes where customer_invoice_id = any($1::int[])`,
          [invoiceIds],
          tx
        )
      ).rowCount;
      deleted.ar_adjustments = (
        await tryQ(
          client,
          `delete from customer_ar_adjustments where customer_invoice_id = any($1::int[])`,
          [invoiceIds],
          tx
        )
      ).rowCount;
      deleted.einvoice_events = (
        await tryQ(
          client,
          `delete from einvoice_events where customer_invoice_id = any($1::int[])`,
          [invoiceIds],
          tx
        )
      ).rowCount;

      // Clear proforma converted_invoice pointers before invoice delete
      await tryQ(
        client,
        `update proforma_invoices set converted_invoice_id = null where converted_invoice_id = any($1::int[])`,
        [invoiceIds],
        tx
      );

      deleted.invoices = (await q(client, `delete from customer_invoices where id = any($1::int[])`, [invoiceIds])).rowCount;

      if (receiptIds.length) {
        const stillLinked = await tryQ(
          client,
          `select distinct customer_receipt_id from customer_receipt_allocations where customer_receipt_id = any($1::int[])`,
          [receiptIds],
          tx
        );
        const still = new Set((stillLinked.rows || []).map((r) => Number(r.customer_receipt_id)));
        const orphanReceipts = receiptIds.filter((id) => !still.has(id));
        if (orphanReceipts.length) {
          deleted.orphan_receipts = (
            await tryQ(client, `delete from customer_receipts where id = any($1::int[])`, [orphanReceipts], tx)
          ).rowCount;
        }
      }
    }

    // 2) Proformas (lines cascade)
    deleted.proformas = (await q(client, `delete from proforma_invoices where sales_order_id = $1`, [so.id])).rowCount;

    // 3) Dispatches / site readiness / commissioning (cascade where configured)
    deleted.site_readiness = (
      await tryQ(client, `delete from site_readiness_checklists where sales_order_id = $1`, [so.id], tx)
    ).rowCount;
    deleted.commissioning_tickets = (
      await tryQ(client, `delete from commissioning_tickets where sales_order_id = $1`, [so.id], tx)
    ).rowCount;
    deleted.dispatches = (await q(client, `delete from dispatches where sales_order_id = $1`, [so.id])).rowCount;

    // 4) Detach optional FKs then delete SO (lines/milestones cascade)
    await tryQ(client, `update job_cards set sales_order_id = null where sales_order_id = $1`, [so.id], tx);
    await tryQ(client, `update leads set converted_sales_order_id = null where converted_sales_order_id = $1`, [so.id], tx);
    await tryQ(client, `update amc_contracts set sales_order_id = null where sales_order_id = $1`, [so.id], tx);
    await tryQ(client, `update service_warranty_cases set sales_order_id = null where sales_order_id = $1`, [so.id], tx);

    // Clear quote_revision FK on SO before quote delete (no ON DELETE on SO.quote_revision_id)
    await q(client, `update sales_orders set quote_revision_id = null where id = $1`, [so.id]);

    deleted.sales_order = (await q(client, `delete from sales_orders where id = $1`, [so.id])).rowCount;

    // 5) Quote header (revisions/lines cascade). Only if this SO's quote exists.
    if (quote?.quote_id) {
      // Refuse if another live SO still points at any revision of this quote
      const otherSo = await q(
        client,
        `
          select so.id, so.so_number
          from sales_orders so
          join quote_revisions qr on qr.id = so.quote_revision_id
          where qr.quote_id = $1
          limit 5
        `,
        [quote.quote_id]
      );
      if (otherSo.rows.length) {
        throw new Error(
          `Quote ${quote.quote_number} still linked to other SOs: ${otherSo.rows.map((r) => r.so_number).join(", ")}`
        );
      }
      await tryQ(client, `update leads set converted_quote_id = null where converted_quote_id = $1`, [quote.quote_id], tx);
      deleted.quote_headers = (await q(client, `delete from quote_headers where id = $1`, [quote.quote_id])).rowCount;
    }

    await q(client, "commit");
    console.log(
      JSON.stringify(
        {
          ok: true,
          wiped: true,
          so_number: args.so,
          quote_number: quote?.quote_number || null,
          deleted,
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
