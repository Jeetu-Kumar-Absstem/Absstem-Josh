require("dotenv").config();

const { pool } = require("../src/db/pool");

async function main() {
  const tables = [
    ["customer_collection_actions", "customer_collection_actions_company_required_chk"],
    ["customer_collection_disputes", "customer_collection_disputes_company_required_chk"],
    ["customer_ar_adjustments", "customer_ar_adjustments_company_required_chk"],
    ["customer_credit_releases", "customer_credit_releases_company_required_chk"],
  ];

  for (const [table] of tables) {
    const r = await pool.query(`select count(*)::int as cnt from ${table} where company_id is null`);
    const cnt = r.rows[0]?.cnt || 0;
    if (cnt > 0) {
      const err = new Error(`${table} has ${cnt} rows with null company_id`);
      err.code = "NULL_COMPANY_ID";
      throw err;
    }
  }

  for (const [table, constraint] of tables) {
    process.stdout.write(`Validating ${table}.${constraint}\n`);
    await pool.query(`alter table ${table} validate constraint ${constraint}`);
  }

  process.stdout.write("OK\n");
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

