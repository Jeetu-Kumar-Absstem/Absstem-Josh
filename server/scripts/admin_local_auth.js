const crypto = require("crypto");

require("dotenv").config();

const { pool } = require("../src/db/pool");

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      return resolve(derivedKey.toString("base64"));
    });
  });
}

async function setPassword(email, password) {
  const em = String(email || "").trim().toLowerCase();
  if (!em || !password) throw new Error("Missing email or password");

  const userRes = await pool.query(
    `select id, email from erp_users where email = $1 and is_active = true limit 1`,
    [em]
  );
  const user = userRes.rows[0] || null;
  if (!user) throw new Error("User not found");

  const salt = crypto.randomBytes(16).toString("base64");
  const hash = await scryptHash(password, salt);

  await pool.query(
    `
      insert into user_credentials (user_id, password_salt, password_hash, password_algo, updated_at)
      values ($1,$2,$3,'scrypt',now())
      on conflict (user_id) do update set
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        password_algo = excluded.password_algo,
        updated_at = now()
    `,
    [user.id, salt, hash]
  );

  process.stdout.write(`ok: password set for ${user.email}\n`);
}

async function linkDistributor(email, distributorId) {
  const em = String(email || "").trim().toLowerCase();
  const did = Number(distributorId);
  if (!em || !Number.isFinite(did)) throw new Error("Missing email or distributorId");

  const userRes = await pool.query(
    `select id, email from erp_users where email = $1 and is_active = true limit 1`,
    [em]
  );
  const user = userRes.rows[0] || null;
  if (!user) throw new Error("User not found");

  const distRes = await pool.query(
    `select id, company_name from distributors where id = $1 limit 1`,
    [did]
  );
  const dist = distRes.rows[0] || null;
  if (!dist) throw new Error("Distributor not found");

  await pool.query(
    `
      insert into user_distributor_links (user_id, distributor_id)
      values ($1,$2)
      on conflict (user_id) do update set distributor_id = excluded.distributor_id
    `,
    [user.id, dist.id]
  );

  process.stdout.write(`ok: linked ${user.email} -> distributor ${dist.id} (${dist.company_name})\n`);
}

async function listDistributors() {
  const { rows } = await pool.query(
    `select id, company_name from distributors order by company_name asc limit 200`
  );
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

async function main() {
  const cmd = process.argv[2] || "";
  if (cmd === "set-password") {
    await setPassword(process.argv[3], process.argv[4]);
  } else if (cmd === "link-distributor") {
    await linkDistributor(process.argv[3], process.argv[4]);
  } else if (cmd === "list-distributors") {
    await listDistributors();
  } else {
    process.stdout.write(
      [
        "Usage:",
        "  node scripts/admin_local_auth.js set-password <email> <password>",
        "  node scripts/admin_local_auth.js link-distributor <email> <distributor_id>",
        "  node scripts/admin_local_auth.js list-distributors",
      ].join("\n") + "\n"
    );
    process.exit(1);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });

