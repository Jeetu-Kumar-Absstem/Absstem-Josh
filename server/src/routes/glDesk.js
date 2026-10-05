const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 120, max = 400) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(num(value).toFixed(2));
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  return text;
}

function inferNormalBalance(accountType) {
  const t = String(accountType || "").toLowerCase();
  if (t === "asset" || t === "expense") return "debit";
  if (t === "liability" || t === "equity" || t === "income") return "credit";
  return "debit";
}

const DEFAULT_COA = [
  { account_code: "1000", account_name: "Cash", account_type: "asset" },
  { account_code: "1010", account_name: "Bank", account_type: "asset" },
  { account_code: "1100", account_name: "Accounts Receivable", account_type: "asset" },
  { account_code: "2000", account_name: "Accounts Payable", account_type: "liability" },
  { account_code: "3000", account_name: "Equity", account_type: "equity" },
  { account_code: "4000", account_name: "Sales", account_type: "income" },
  { account_code: "5000", account_name: "Purchases", account_type: "expense" },
  { account_code: "6000", account_name: "Freight Expense", account_type: "expense" },
  { account_code: "6100", account_name: "Salary Expense", account_type: "expense" },
];

router.use(requireAuth);

router.get("/summary", requireScreenAction("gl_desk", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthStartText = monthStart.toISOString().slice(0, 10);
  const todayText = today.toISOString().slice(0, 10);

  try {
    const [accountsRes, journalsDraftRes, journalsMonthRes, tbDiffRes] = await Promise.all([
      pool.query(
        `
          select count(*)::int as count
          from gl_accounts
          where company_id = $1 and is_active = true
        `,
        [Number(companyId)]
      ),
      pool.query(
        `
          select count(*)::int as count
          from gl_journals
          where company_id = $1 and journal_status = 'draft'
        `,
        [Number(companyId)]
      ),
      pool.query(
        `
          select count(*)::int as count
          from gl_journals
          where company_id = $1 and journal_status = 'posted'
            and journal_date between $2 and $3
        `,
        [Number(companyId), monthStartText, todayText]
      ),
      pool.query(
        `
          select
            coalesce(sum(l.debit), 0) as total_debit,
            coalesce(sum(l.credit), 0) as total_credit
          from gl_journals j
          join gl_journal_lines l on l.journal_id = j.id
          where j.company_id = $1 and j.journal_status = 'posted'
            and j.journal_date between $2 and $3
        `,
        [Number(companyId), monthStartText, todayText]
      ),
    ]);

    const totalDebit = money(tbDiffRes.rows[0]?.total_debit);
    const totalCredit = money(tbDiffRes.rows[0]?.total_credit);
    return res.json({
      ok: true,
      summary: {
        active_accounts: accountsRes.rows[0]?.count || 0,
        draft_journals: journalsDraftRes.rows[0]?.count || 0,
        posted_this_month: journalsMonthRes.rows[0]?.count || 0,
        trial_balance_diff_this_month: money(totalDebit - totalCredit),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/bootstrap", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const countRes = await client.query(`select count(*)::int as count from gl_accounts where company_id = $1`, [Number(companyId)]);
      if ((countRes.rows[0]?.count || 0) === 0) {
        for (const row of DEFAULT_COA) {
          const normal = inferNormalBalance(row.account_type);
          await client.query(
            `
              insert into gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
              values ($1, $2, $3, $4, $5)
              on conflict (company_id, account_code) do nothing
            `,
            [Number(companyId), row.account_code, row.account_name, row.account_type, normal]
          );
        }
      }
      await client.query("commit");
      return res.json({ ok: true });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.get("/accounts", requireScreenAction("gl_desk", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const q = normalizeText(req.query.q);
  try {
    const params = [Number(companyId)];
    const where = ["company_id = $1"];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(account_code ilike $${params.length} or account_name ilike $${params.length})`);
    }
    const r = await pool.query(
      `
        select *
        from gl_accounts
        where ${where.join(" and ")}
        order by is_active desc, account_type asc, account_code asc, id asc
      `,
      params
    );
    return res.json({ ok: true, accounts: r.rows || [] });
  } catch (err) {
    return next(err);
  }
});

router.post("/accounts", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const accountCode = normalizeText(req.body?.account_code);
  const accountName = normalizeText(req.body?.account_name);
  const accountType = normalizeText(req.body?.account_type).toLowerCase();
  const normalBalance = normalizeText(req.body?.normal_balance).toLowerCase() || inferNormalBalance(accountType);
  if (!accountCode) return res.status(400).json({ ok: false, error: "ACCOUNT_CODE_REQUIRED" });
  if (!accountName) return res.status(400).json({ ok: false, error: "ACCOUNT_NAME_REQUIRED" });
  if (!accountType) return res.status(400).json({ ok: false, error: "ACCOUNT_TYPE_REQUIRED" });

  try {
    const r = await pool.query(
      `
        insert into gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [Number(companyId), accountCode, accountName, accountType, normalBalance]
    );
    return res.json({ ok: true, account: r.rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.patch("/accounts/:id", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

  const fields = {};
  if (typeof req.body?.account_name === "string") fields.account_name = normalizeText(req.body.account_name);
  if (typeof req.body?.account_type === "string") fields.account_type = normalizeText(req.body.account_type).toLowerCase();
  if (typeof req.body?.normal_balance === "string") fields.normal_balance = normalizeText(req.body.normal_balance).toLowerCase();
  if (typeof req.body?.is_active === "boolean") fields.is_active = req.body.is_active;

  const keys = Object.keys(fields);
  if (!keys.length) return res.status(400).json({ ok: false, error: "NO_CHANGES" });

  try {
    const sets = [];
    const params = [id, Number(companyId)];
    keys.forEach((k) => {
      params.push(fields[k]);
      sets.push(`${k} = $${params.length}`);
    });
    const r = await pool.query(
      `
        update gl_accounts
        set ${sets.join(", ")}, updated_at = now()
        where id = $1 and company_id = $2
        returning *
      `,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, account: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

async function getJournalHeader(client, companyId, journalId) {
  const r = await client.query(`select * from gl_journals where id = $1 and company_id = $2 limit 1`, [journalId, Number(companyId)]);
  return r.rows[0] || null;
}

async function getJournalLines(client, companyId, journalId) {
  const r = await client.query(
    `
      select
        l.*,
        a.account_code,
        a.account_name,
        a.account_type,
        a.normal_balance
      from gl_journal_lines l
      join gl_accounts a on a.id = l.account_id and a.company_id = $2
      join gl_journals j on j.id = l.journal_id and j.company_id = $2
      where l.journal_id = $1
      order by l.line_no asc, l.id asc
    `,
    [journalId, Number(companyId)]
  );
  return r.rows || [];
}

router.get("/journals", requireScreenAction("gl_desk", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  const status = normalizeText(req.query.status).toLowerCase();
  const q = normalizeText(req.query.q);
  const fromDate = normalizeDate(req.query.from);
  const toDate = normalizeDate(req.query.to);
  const limit = normalizeLimit(req.query.limit, 120, 400);

  try {
    const params = [Number(companyId)];
    const where = ["j.company_id = $1"];
    if (status && status !== "all") {
      params.push(status);
      where.push(`j.journal_status = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      where.push(`j.journal_date >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      where.push(`j.journal_date <= $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(j.journal_no ilike $${params.length} or coalesce(j.narration, '') ilike $${params.length})`);
    }
    params.push(limit);
    const r = await pool.query(
      `
        select
          j.*,
          coalesce(sum(l.debit), 0) as total_debit,
          coalesce(sum(l.credit), 0) as total_credit
        from gl_journals j
        left join gl_journal_lines l on l.journal_id = j.id
        where ${where.join(" and ")}
        group by j.id
        order by j.journal_date desc, j.id desc
        limit $${params.length}
      `,
      params
    );
    const journals = (r.rows || []).map((row) => {
      const totalDebit = money(row.total_debit);
      const totalCredit = money(row.total_credit);
      return {
        ...row,
        total_debit: totalDebit,
        total_credit: totalCredit,
        is_balanced: money(totalDebit - totalCredit) === 0,
      };
    });
    return res.json({ ok: true, journals });
  } catch (err) {
    return next(err);
  }
});

router.post("/journals", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const journalDate = normalizeDate(req.body?.journal_date) || new Date().toISOString().slice(0, 10);
  const narration = normalizeText(req.body?.narration);

  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const noRes = await client.query(`select next_company_running_sequence($1, 'GL_JV', 'JV', 5) as journal_no`, [Number(companyId)]);
      const journalNo = normalizeText(noRes.rows[0]?.journal_no);
      const r = await client.query(
        `
          insert into gl_journals (company_id, journal_no, journal_date, narration, created_by)
          values ($1, $2, $3, $4, $5)
          returning *
        `,
        [Number(companyId), journalNo, journalDate, narration || null, Number(req.user.id)]
      );
      await client.query("commit");
      return res.json({ ok: true, journal: r.rows[0] || null });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.get("/journals/:id", requireScreenAction("gl_desk", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

  try {
    const client = await pool.connect();
    try {
      const journal = await getJournalHeader(client, companyId, id);
      if (!journal) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      const lines = await getJournalLines(client, companyId, id);
      return res.json({ ok: true, journal, lines });
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.put("/journals/:id", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

  const journalDate = normalizeDate(req.body?.journal_date);
  const narration = typeof req.body?.narration === "string" ? normalizeText(req.body.narration) : null;
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];

  const lines = rawLines
    .map((row) => ({
      account_id: Number(row?.account_id),
      debit: money(row?.debit),
      credit: money(row?.credit),
      line_remarks: normalizeText(row?.line_remarks),
    }))
    .filter((row) => Number.isFinite(row.account_id) && row.account_id > 0 && (row.debit > 0 || row.credit > 0));

  if (!lines.length) return res.status(400).json({ ok: false, error: "LINES_REQUIRED" });

  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const header = await getJournalHeader(client, companyId, id);
      if (!header) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }
      if (header.journal_status !== "draft") {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ONLY_DRAFT_EDITABLE" });
      }

      const uniqueAccountIds = Array.from(new Set(lines.map((row) => row.account_id)));
      const acctRes = await client.query(
        `
          select id
          from gl_accounts
          where company_id = $1 and id = any($2::int[])
        `,
        [Number(companyId), uniqueAccountIds]
      );
      const found = new Set((acctRes.rows || []).map((row) => Number(row.id)));
      const missing = uniqueAccountIds.filter((acctId) => !found.has(acctId));
      if (missing.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ACCOUNT_NOT_FOUND", detail: "One or more accounts are missing for this company." });
      }

      if (journalDate || narration !== null) {
        const sets = [];
        const params = [id, Number(companyId)];
        if (journalDate) {
          params.push(journalDate);
          sets.push(`journal_date = $${params.length}`);
        }
        if (narration !== null) {
          params.push(narration || null);
          sets.push(`narration = $${params.length}`);
        }
        if (sets.length) {
          await client.query(`update gl_journals set ${sets.join(", ")}, updated_at = now() where id = $1 and company_id = $2`, params);
        }
      }

      await client.query(`delete from gl_journal_lines where journal_id = $1`, [id]);
      let lineNo = 1;
      for (const row of lines) {
        await client.query(
          `
            insert into gl_journal_lines (journal_id, line_no, account_id, line_remarks, debit, credit)
            values ($1, $2, $3, $4, $5, $6)
          `,
          [id, lineNo, row.account_id, row.line_remarks || null, row.debit, row.credit]
        );
        lineNo += 1;
      }

      await client.query("commit");
      const updated = await pool.query(`select * from gl_journals where id = $1 and company_id = $2`, [id, Number(companyId)]);
      const outLines = await pool.query(
        `
          select
            l.*,
            a.account_code,
            a.account_name,
            a.account_type,
            a.normal_balance
          from gl_journal_lines l
          join gl_accounts a on a.id = l.account_id and a.company_id = $2
          where l.journal_id = $1
          order by l.line_no asc, l.id asc
        `,
        [id, Number(companyId)]
      );
      return res.json({ ok: true, journal: updated.rows[0] || null, lines: outLines.rows || [] });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.post("/journals/:id/post", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const headerRes = await client.query(`select * from gl_journals where id = $1 and company_id = $2 for update`, [id, Number(companyId)]);
      const header = headerRes.rows[0] || null;
      if (!header) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }
      if (header.journal_status !== "draft") {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ONLY_DRAFT_POSTABLE" });
      }

      const totalsRes = await client.query(
        `
          select
            coalesce(sum(debit), 0) as total_debit,
            coalesce(sum(credit), 0) as total_credit,
            count(*)::int as line_count
          from gl_journal_lines
          where journal_id = $1
        `,
        [id]
      );
      const totals = totalsRes.rows[0] || {};
      const totalDebit = money(totals.total_debit);
      const totalCredit = money(totals.total_credit);
      if (!totals.line_count) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "LINES_REQUIRED" });
      }
      if (money(totalDebit - totalCredit) !== 0) {
        await client.query("rollback");
        return res.status(400).json({
          ok: false,
          error: "JOURNAL_NOT_BALANCED",
          detail: "Total debit must match total credit before posting.",
        });
      }

      await client.query(
        `
          update gl_journals
          set journal_status = 'posted', posted_by = $3, posted_at = now(), updated_at = now()
          where id = $1 and company_id = $2
        `,
        [id, Number(companyId), Number(req.user.id)]
      );
      await client.query("commit");
      const out = await pool.query(`select * from gl_journals where id = $1 and company_id = $2`, [id, Number(companyId)]);
      return res.json({ ok: true, journal: out.rows[0] || null });
    } catch (err) {
      await client.query("rollback");
      return next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.post("/journals/:id/cancel", requireScreenAction("gl_desk", "can_edit"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

  try {
    const r = await pool.query(
      `
        update gl_journals
        set journal_status = 'cancelled', updated_at = now()
        where id = $1 and company_id = $2 and journal_status = 'draft'
        returning *
      `,
      [id, Number(companyId)]
    );
    if (!r.rows[0]) return res.status(400).json({ ok: false, error: "ONLY_DRAFT_CANCELLABLE" });
    return res.json({ ok: true, journal: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/trial-balance", requireScreenAction("gl_desk", "can_view"), async (req, res, next) => {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fromDate = normalizeDate(req.query.from) || monthStart.toISOString().slice(0, 10);
  const toDate = normalizeDate(req.query.to) || today.toISOString().slice(0, 10);

  try {
    const r = await pool.query(
      `
        with opening as (
          select
            l.account_id,
            coalesce(sum(l.debit), 0) as opening_debit,
            coalesce(sum(l.credit), 0) as opening_credit
          from gl_journals j
          join gl_journal_lines l on l.journal_id = j.id
          where j.company_id = $1 and j.journal_status = 'posted'
            and j.journal_date < $2
          group by l.account_id
        ),
        period as (
          select
            l.account_id,
            coalesce(sum(l.debit), 0) as period_debit,
            coalesce(sum(l.credit), 0) as period_credit
          from gl_journals j
          join gl_journal_lines l on l.journal_id = j.id
          where j.company_id = $1 and j.journal_status = 'posted'
            and j.journal_date between $2 and $3
          group by l.account_id
        )
        select
          a.id as account_id,
          a.account_code,
          a.account_name,
          a.account_type,
          a.normal_balance,
          coalesce(o.opening_debit, 0) as opening_debit,
          coalesce(o.opening_credit, 0) as opening_credit,
          coalesce(p.period_debit, 0) as period_debit,
          coalesce(p.period_credit, 0) as period_credit
        from gl_accounts a
        left join opening o on o.account_id = a.id
        left join period p on p.account_id = a.id
        where a.company_id = $1 and a.is_active = true
        order by a.account_type asc, a.account_code asc, a.id asc
      `,
      [Number(companyId), fromDate, toDate]
    );

    const rows = (r.rows || []).map((row) => {
      const openingBalance = money(money(row.opening_debit) - money(row.opening_credit));
      const periodBalance = money(money(row.period_debit) - money(row.period_credit));
      const closingBalance = money(openingBalance + periodBalance);
      return {
        ...row,
        opening_debit: money(row.opening_debit),
        opening_credit: money(row.opening_credit),
        period_debit: money(row.period_debit),
        period_credit: money(row.period_credit),
        closing_debit: closingBalance > 0 ? closingBalance : 0,
        closing_credit: closingBalance < 0 ? money(Math.abs(closingBalance)) : 0,
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        acc.period_debit = money(acc.period_debit + money(row.period_debit));
        acc.period_credit = money(acc.period_credit + money(row.period_credit));
        return acc;
      },
      { period_debit: 0, period_credit: 0 }
    );

    return res.json({
      ok: true,
      from: fromDate,
      to: toDate,
      totals: {
        period_debit: totals.period_debit,
        period_credit: totals.period_credit,
        diff: money(totals.period_debit - totals.period_credit),
      },
      rows,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
