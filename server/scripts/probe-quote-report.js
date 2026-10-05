/**
 * Read-only diagnostic: calls the Quote Report handlers directly (bypassing HTTP/auth)
 * and prints status, timing, and any error. Safe to run against live.
 *
 *   docker compose -f docker-compose.prod.yml exec -T api node scripts/probe-quote-report.js [companyId]
 */
const path = require("path");
const router = require(path.join(__dirname, "../src/routes/quotes.js"));
const { pool } = require(path.join(__dirname, "../src/db/pool.js"));

function runRoute(routePath, { user, ctx, query }) {
  return new Promise((resolve) => {
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
    if (!layer) return resolve({ status: 404, body: "route not found" });
    const req = { method: "GET", user, ctx, query, params: {}, headers: {}, session: {}, get: () => "" };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      setHeader() {},
    };
    const handles = layer.route.stack.map((s) => s.handle);
    let i = 0;
    const next = (err) => {
      if (err) return resolve({ status: 500, error: err });
      const h = handles[i++];
      if (!h) return resolve({ status: 0, body: "fell through" });
      try {
        const p = h(req, res, next);
        if (p && p.catch) p.catch((e) => resolve({ status: 500, error: e }));
      } catch (e) {
        resolve({ status: 500, error: e });
      }
    };
    next();
  });
}

(async () => {
  const companyId = Number(process.argv[2] || 2);
  const user = { id: 1, group_name: "SuperAdmin", permissions: { screens: {}, modules: {} } };
  const ctx = { company_id: companyId, active_company_id: companyId };
  for (const [label, query] of [
    ["all time", {}],
    ["this month", { date_from: new Date().toISOString().slice(0, 8) + "01", date_to: new Date().toISOString().slice(0, 10) }],
  ]) {
    for (const p of ["/report/bootstrap", "/report", "/report/win-loss"]) {
      const t0 = Date.now();
      const r = await runRoute(p, { user, ctx, query });
      const ms = Date.now() - t0;
      const line = r.error
        ? `ERROR ${r.error.code || ""} ${r.error.message}${r.error.position ? ` @pos ${r.error.position}` : ""}${r.error.where ? ` | ${r.error.where}` : ""}`
        : `status ${r.status}${r.status >= 400 ? ` body=${JSON.stringify(r.body).slice(0, 300)}` : ""} quotes=${r.body?.totals?.quote_count ?? "-"}`;
      console.log(`${label.padEnd(10)} ${p.padEnd(18)} ${String(ms).padStart(6)}ms  ${line}`);
    }
  }
  await pool.end();
})().catch((e) => {
  console.error("PROBE FAILED", e.stack || e.message);
  process.exit(1);
});
