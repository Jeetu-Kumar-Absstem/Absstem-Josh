require("dotenv").config();

const { pool } = require("../src/db/pool");

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

function printSection(title) {
  process.stdout.write(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}\n`);
}

async function main() {
  printSection("Collections/Credit company_id completeness");
  for (const table of [
    "customer_collection_actions",
    "customer_collection_disputes",
    "customer_ar_adjustments",
    "customer_credit_releases",
  ]) {
    const rows = await q(`select count(*)::int as cnt from ${table} where company_id is null`);
    process.stdout.write(`${table}: null company_id = ${rows[0]?.cnt || 0}\n`);
  }

  const ambiguousCustomers = await q(
    `
      select customer_id, count(distinct company_id)::int as company_count
      from customer_company_links
      where is_active = true
      group by customer_id
      having count(distinct company_id) > 1
      order by company_count desc, customer_id asc
      limit 50
    `
  );
  process.stdout.write(`\nCustomers linked to multiple companies (sample): ${ambiguousCustomers.length}\n`);
  for (const row of ambiguousCustomers) {
    process.stdout.write(`- customer_id=${row.customer_id} companies=${row.company_count}\n`);
  }

  printSection("Inbound lead review company_id completeness");
  const mbNull = await q(`select count(*)::int as cnt from inbound_mailboxes where company_id is null`);
  const emNull = await q(`select count(*)::int as cnt from inbound_lead_emails where company_id is null`);
  process.stdout.write(`inbound_mailboxes: null company_id = ${mbNull[0]?.cnt || 0}\n`);
  process.stdout.write(`inbound_lead_emails: null company_id = ${emNull[0]?.cnt || 0}\n`);

  const mbSample = await q(
    `
      select mailbox_key, mailbox_email, company_id, is_active, updated_at
      from inbound_mailboxes
      order by updated_at desc nulls last, mailbox_key asc
      limit 50
    `
  );
  process.stdout.write(`\nInbound mailboxes (sample): ${mbSample.length}\n`);
  for (const row of mbSample) {
    process.stdout.write(`- ${row.mailbox_key} ${row.mailbox_email || ""} company_id=${row.company_id || "null"} active=${row.is_active}\n`);
  }

  printSection("Vendors by company");
  const vendorCounts = await q(
    `
      select company_id, count(*)::int as cnt
      from vendors
      group by company_id
      order by company_id asc
    `
  );
  for (const row of vendorCounts) {
    process.stdout.write(`company_id=${row.company_id}: vendors=${row.cnt}\n`);
  }

  const vendorNulls = await q(`select count(*)::int as cnt from vendors where company_id is null`);
  process.stdout.write(`\nvendors: null company_id = ${vendorNulls[0]?.cnt || 0}\n`);

  printSection("Attachments with missing ownership metadata");
  const attachmentNulls = await q(
    `
      select count(*)::int as cnt
      from attachments
      where company_id is null or owner_type is null or owner_id is null
    `
  );
  process.stdout.write(`attachments: missing ownership fields = ${attachmentNulls[0]?.cnt || 0}\n`);
}

main()
  .then(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });

