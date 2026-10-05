import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskTopStrip, FieldLabel, NoticeBanner, getDeskStatusAppearance } from "../shared/joshUi";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return num(value).toFixed(2);
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["posted"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const panel = typeof value.panel === "string" ? value.panel : "";
  const journalId = Number(value.journal_id ?? value.journalId ?? value.id ?? 0);
  return {
    panel,
    journal_id: Number.isFinite(journalId) && journalId > 0 ? journalId : null,
  };
}

const PANELS = [
  { key: "accounts", label: "Chart of accounts" },
  { key: "journals", label: "Journals" },
  { key: "trial_balance", label: "Trial balance" },
];

const JOURNAL_STATUS = [
  ["draft", "Draft"],
  ["posted", "Posted"],
  ["cancelled", "Cancelled"],
  ["all", "All"],
];

const ACCOUNT_TYPES = [
  ["asset", "Asset"],
  ["liability", "Liability"],
  ["equity", "Equity"],
  ["income", "Income"],
  ["expense", "Expense"],
];

const NORMAL_BALANCES = [
  ["debit", "Debit"],
  ["credit", "Credit"],
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function buildEmptyJournalLine(accounts) {
  const firstAccount = Array.isArray(accounts) && accounts.length ? Number(accounts[0].id) : 0;
  return {
    account_id: firstAccount > 0 ? firstAccount : "",
    debit: "",
    credit: "",
    line_remarks: "",
  };
}

export default function GlDesk({ launch = null, onConsumeLaunch = null } = {}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [panel, setPanel] = useState("journals");

  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState(null);

  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountsQuery, setAccountsQuery] = useState("");
  const [newAccount, setNewAccount] = useState({ account_code: "", account_name: "", account_type: "asset", normal_balance: "debit" });

  const [journalsLoading, setJournalsLoading] = useState(false);
  const [journals, setJournals] = useState([]);
  const [journalsQuery, setJournalsQuery] = useState("");
  const [journalsStatus, setJournalsStatus] = useState("draft");
  const [journalsFrom, setJournalsFrom] = useState(monthStartIso());
  const [journalsTo, setJournalsTo] = useState(todayIso());

  const [journalView, setJournalView] = useState({ type: "list", id: null });
  const [journal, setJournal] = useState(null);
  const [journalLines, setJournalLines] = useState([]);
  const [journalWorking, setJournalWorking] = useState(false);

  const [trialLoading, setTrialLoading] = useState(false);
  const [trialFrom, setTrialFrom] = useState(monthStartIso());
  const [trialTo, setTrialTo] = useState(todayIso());
  const [trial, setTrial] = useState(null);

  const topMetrics = useMemo(() => {
    return [
      {
        label: "Active accounts",
        value: String(summary?.active_accounts ?? 0),
        tone: "#234a8f",
        note: "Open chart of accounts",
        onClick: () => setPanel("accounts"),
      },
      {
        label: "Draft journals",
        value: String(summary?.draft_journals ?? 0),
        tone: "#8b5a00",
        note: "Open draft journals",
        onClick: () => {
          setPanel("journals");
          setJournalsStatus("draft");
        },
      },
      {
        label: "Posted (month)",
        value: String(summary?.posted_this_month ?? 0),
        tone: "#0b7d45",
        note: "Open posted journals",
        onClick: () => {
          setPanel("journals");
          setJournalsStatus("posted");
        },
      },
      {
        label: "TB diff (month)",
        value: money(summary?.trial_balance_diff_this_month ?? 0),
        tone: "#9f2042",
        note: "Open trial balance",
        onClick: () => setPanel("trial_balance"),
      },
    ];
  }, [summary]);

  const journalTotals = useMemo(() => {
    const totals = journalLines.reduce(
      (acc, row) => {
        acc.debit += num(row.debit);
        acc.credit += num(row.credit);
        return acc;
      },
      { debit: 0, credit: 0 }
    );
    return {
      debit: totals.debit,
      credit: totals.credit,
      diff: totals.debit - totals.credit,
    };
  }, [journalLines]);

  async function loadSummary() {
    setSummaryLoading(true);
    setError("");
    try {
      const data = await apiFetch("/gl-desk/summary");
      if (data?.ok) setSummary(data.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load GL Desk summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadAccounts(nextQuery = accountsQuery) {
    setAccountsLoading(true);
    setError("");
    try {
      const qp = nextQuery ? `?q=${encodeURIComponent(nextQuery)}` : "";
      const data = await apiFetch(`/gl-desk/accounts${qp}`);
      if (data?.ok) setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load chart of accounts."));
    } finally {
      setAccountsLoading(false);
    }
  }

  async function bootstrapCoa() {
    setAccountsLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/gl-desk/bootstrap", { method: "POST", body: JSON.stringify({}) });
      if (data?.ok) {
        setNotice("Default chart of accounts created.");
        await loadAccounts("");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create default COA."));
    } finally {
      setAccountsLoading(false);
    }
  }

  async function createAccount() {
    setAccountsLoading(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        account_code: newAccount.account_code,
        account_name: newAccount.account_name,
        account_type: newAccount.account_type,
        normal_balance: newAccount.normal_balance,
      };
      const data = await apiFetch("/gl-desk/accounts", { method: "POST", body: JSON.stringify(payload) });
      if (data?.ok) {
        setNewAccount({ account_code: "", account_name: "", account_type: "asset", normal_balance: "debit" });
        await loadAccounts(accountsQuery);
        await loadSummary();
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create account."));
    } finally {
      setAccountsLoading(false);
    }
  }

  async function toggleAccountActive(row) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) return;
    setAccountsLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/gl-desk/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ is_active: !row.is_active }) });
      if (data?.ok) {
        await loadAccounts(accountsQuery);
        await loadSummary();
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to update account."));
    } finally {
      setAccountsLoading(false);
    }
  }

  async function loadJournals() {
    setJournalsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (journalsQuery) params.set("q", journalsQuery);
      params.set("status", journalsStatus);
      if (journalsFrom) params.set("from", journalsFrom);
      if (journalsTo) params.set("to", journalsTo);
      params.set("limit", "200");
      const data = await apiFetch(`/gl-desk/journals?${params.toString()}`);
      if (data?.ok) setJournals(Array.isArray(data.journals) ? data.journals : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load journals."));
    } finally {
      setJournalsLoading(false);
    }
  }

  async function openJournal(id) {
    const journalId = Number(id);
    if (!Number.isFinite(journalId) || journalId <= 0) return;
    setJournalWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/gl-desk/journals/${journalId}`);
      if (data?.ok) {
        setJournal(data.journal || null);
        const rows = Array.isArray(data.lines) ? data.lines : [];
        const mapped = rows.map((row) => ({
          account_id: row.account_id,
          debit: row.debit ? String(row.debit) : "",
          credit: row.credit ? String(row.credit) : "",
          line_remarks: row.line_remarks || "",
        }));
        setJournalLines(mapped.length ? mapped : [buildEmptyJournalLine(accounts)]);
        setJournalView({ type: "detail", id: journalId });
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load journal."));
    } finally {
      setJournalWorking(false);
    }
  }

  async function createJournal() {
    setJournalsLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/gl-desk/journals", { method: "POST", body: JSON.stringify({ journal_date: todayIso(), narration: "" }) });
      if (data?.ok && data.journal?.id) {
        await loadJournals();
        await loadSummary();
        await openJournal(data.journal.id);
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create journal."));
    } finally {
      setJournalsLoading(false);
    }
  }

  function updateJournalLine(index, patch) {
    setJournalLines((prev) => {
      const next = prev.slice();
      const current = next[index] || {};
      next[index] = { ...current, ...patch };
      return next;
    });
  }

  function addJournalLine() {
    setJournalLines((prev) => [...prev, buildEmptyJournalLine(accounts)]);
  }

  function removeJournalLine(index) {
    setJournalLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveJournal() {
    const journalId = Number(journal?.id || journalView.id);
    if (!Number.isFinite(journalId) || journalId <= 0) return;
    setJournalWorking(true);
    setError("");
    setNotice("");
    try {
      const payloadLines = journalLines
        .map((row) => ({
          account_id: Number(row.account_id),
          debit: row.debit === "" ? 0 : num(row.debit),
          credit: row.credit === "" ? 0 : num(row.credit),
          line_remarks: row.line_remarks || "",
        }))
        .filter((row) => Number.isFinite(row.account_id) && row.account_id > 0 && (row.debit > 0 || row.credit > 0));
      const data = await apiFetch(`/gl-desk/journals/${journalId}`, {
        method: "PUT",
        body: JSON.stringify({
          journal_date: journal?.journal_date,
          narration: journal?.narration || "",
          lines: payloadLines,
        }),
      });
      if (data?.ok) {
        setNotice("Journal saved.");
        setJournal(data.journal || null);
        const rows = Array.isArray(data.lines) ? data.lines : [];
        setJournalLines(
          rows.map((row) => ({
            account_id: row.account_id,
            debit: row.debit ? String(row.debit) : "",
            credit: row.credit ? String(row.credit) : "",
            line_remarks: row.line_remarks || "",
          }))
        );
        await loadJournals();
        await loadSummary();
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save journal."));
    } finally {
      setJournalWorking(false);
    }
  }

  async function postJournal() {
    const journalId = Number(journal?.id || journalView.id);
    if (!Number.isFinite(journalId) || journalId <= 0) return;
    setJournalWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/gl-desk/journals/${journalId}/post`, { method: "POST", body: JSON.stringify({}) });
      if (data?.ok) {
        setNotice("Journal posted.");
        await openJournal(journalId);
        await loadJournals();
        await loadSummary();
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to post journal."));
    } finally {
      setJournalWorking(false);
    }
  }

  async function cancelJournal() {
    const journalId = Number(journal?.id || journalView.id);
    if (!Number.isFinite(journalId) || journalId <= 0) return;
    setJournalWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/gl-desk/journals/${journalId}/cancel`, { method: "POST", body: JSON.stringify({}) });
      if (data?.ok) {
        setNotice("Journal cancelled.");
        await openJournal(journalId);
        await loadJournals();
        await loadSummary();
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to cancel journal."));
    } finally {
      setJournalWorking(false);
    }
  }

  async function loadTrialBalance() {
    setTrialLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (trialFrom) params.set("from", trialFrom);
      if (trialTo) params.set("to", trialTo);
      const data = await apiFetch(`/gl-desk/trial-balance?${params.toString()}`);
      if (data?.ok) setTrial(data);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load trial balance."));
    } finally {
      setTrialLoading(false);
    }
  }

  useEffect(() => {
    loadSummary();
    loadAccounts("");
  }, []);

  useEffect(() => {
    if (panel === "journals") loadJournals();
    if (panel === "trial_balance") loadTrialBalance();
  }, [panel]);

  useEffect(() => {
    const next = normalizeLaunch(launch);
    if (!next) return;
    if (next.panel && PANELS.some((row) => row.key === next.panel)) {
      setPanel(next.panel);
    }
    if (next.journal_id) {
      setPanel("journals");
      openJournal(next.journal_id);
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const leftPanel = (
    <DeskCard
      title="Work areas"
      subtitle={summaryLoading ? "Loading summary…" : "Accounts, journals, and reporting"}
      actions={
        <button type="button" className="button-ghost compact-button" onClick={() => loadSummary()}>
          Refresh
        </button>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        {PANELS.map((row) => (
          <button
            key={row.key}
            type="button"
            className="status-rack-item"
            onClick={() => {
              setNotice("");
              setError("");
              setJournalView({ type: "list", id: null });
              setJournal(null);
              setJournalLines([]);
              setPanel(row.key);
            }}
            style={{
              textAlign: "left",
              cursor: "pointer",
              border: "1px solid #e6ebf2",
              background: panel === row.key ? "#eef4ff" : "#ffffff",
            }}
          >
            <div style={{ fontWeight: 800 }}>{row.label}</div>
          </button>
        ))}
      </div>
    </DeskCard>
  );

  const accountsPanel = (
    <div style={{ display: "grid", gap: 14 }}>
      <DeskCard
        title="Chart of accounts"
        subtitle={accountsLoading ? "Loading…" : `${accounts.length} accounts`}
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              value={accountsQuery}
              onChange={(e) => setAccountsQuery(e.target.value)}
              placeholder="Search code or name"
              style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1", minWidth: 220 }}
            />
            <button type="button" className="button-ghost compact-button" onClick={() => loadAccounts(accountsQuery)}>
              Search
            </button>
            <button type="button" className="button-ghost compact-button" onClick={() => bootstrapCoa()}>
              Bootstrap COA
            </button>
          </div>
        }
      >
        {accounts.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {accounts.map((row) => (
              <div
                key={row.id}
                style={{
                  border: "1px solid #e6ebf2",
                  borderRadius: 16,
                  padding: 12,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 900 }}>
                    {row.account_code} · {row.account_name}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <DeskChip label={String(row.account_type || "").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                    <DeskChip label={`Normal: ${row.normal_balance}`} tone="#f6f7fb" color="#58627a" />
                    <DeskChip label={row.is_active ? "Active" : "Inactive"} tone={row.is_active ? "#effcf3" : "#f5f6fa"} color={row.is_active ? "#0b7d45" : "#5d6782"} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button type="button" className="button-ghost compact-button" onClick={() => toggleAccountActive(row)}>
                    {row.is_active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ opacity: 0.72 }}>No accounts found for this company.</div>
        )}
      </DeskCard>

      <DeskCard title="Add account" subtitle="Create a new GL account">
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <FieldLabel label="Account code">
              <input
                value={newAccount.account_code}
                onChange={(e) => setNewAccount((prev) => ({ ...prev, account_code: e.target.value }))}
                style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
              />
            </FieldLabel>
            <FieldLabel label="Account name">
              <input
                value={newAccount.account_name}
                onChange={(e) => setNewAccount((prev) => ({ ...prev, account_name: e.target.value }))}
                style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
              />
            </FieldLabel>
            <FieldLabel label="Account type">
              <select
                value={newAccount.account_type}
                onChange={(e) => {
                  const value = e.target.value;
                  const normal = value === "asset" || value === "expense" ? "debit" : "credit";
                  setNewAccount((prev) => ({ ...prev, account_type: value, normal_balance: normal }));
                }}
                style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
              >
                {ACCOUNT_TYPES.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Normal balance">
              <select
                value={newAccount.normal_balance}
                onChange={(e) => setNewAccount((prev) => ({ ...prev, normal_balance: e.target.value }))}
                style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
              >
                {NORMAL_BALANCES.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </FieldLabel>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="button-primary" onClick={() => createAccount()} disabled={accountsLoading}>
              Create account
            </button>
          </div>
        </div>
      </DeskCard>
    </div>
  );

  const journalsList = (
    <DeskCard
      title="Journals"
      subtitle={journalsLoading ? "Loading…" : `${journals.length} rows`}
      actions={
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <select value={journalsStatus} onChange={(e) => setJournalsStatus(e.target.value)} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1" }}>
            {JOURNAL_STATUS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <input value={journalsFrom} onChange={(e) => setJournalsFrom(e.target.value)} type="date" style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1" }} />
          <input value={journalsTo} onChange={(e) => setJournalsTo(e.target.value)} type="date" style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1" }} />
          <input
            value={journalsQuery}
            onChange={(e) => setJournalsQuery(e.target.value)}
            placeholder="Search journal no or narration"
            style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1", minWidth: 220 }}
          />
          <button type="button" className="button-ghost compact-button" onClick={() => loadJournals()}>
            Search
          </button>
          <button type="button" className="button-primary" onClick={() => createJournal()} disabled={journalsLoading}>
            New journal
          </button>
        </div>
      }
    >
      {journals.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {journals.map((row) => {
            const appearance = statusAppearance(row.journal_status);
            return (
              <button
                key={row.id}
                type="button"
                className="status-rack-item"
                onClick={() => openJournal(row.id)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  border: "1px solid #e6ebf2",
                  background: "#ffffff",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 900 }}>
                      {row.journal_no} · {fmtDate(row.journal_date)}
                    </div>
                    <div style={{ opacity: 0.7, fontSize: 13 }}>{row.narration || "—"}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <DeskChip label={row.journal_status} tone={appearance.tone} color={appearance.color} />
                      <DeskChip label={`Dr ${money(row.total_debit)}`} tone="#f6f7fb" color="#58627a" />
                      <DeskChip label={`Cr ${money(row.total_credit)}`} tone="#f6f7fb" color="#58627a" />
                      <DeskChip
                        label={row.is_balanced ? "Balanced" : "Not balanced"}
                        tone={row.is_balanced ? "#effcf3" : "#fff2f3"}
                        color={row.is_balanced ? "#0b7d45" : "#9f2042"}
                      />
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ opacity: 0.72 }}>No journals found.</div>
      )}
    </DeskCard>
  );

  const journalDetail = journal ? (
    <DeskCard
      title={`${journal.journal_no || "Journal"} · ${fmtDate(journal.journal_date)}`}
      subtitle="Edit lines, then save and post"
      actions={
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="button-ghost compact-button" onClick={() => setJournalView({ type: "list", id: null })}>
            Back
          </button>
          <button type="button" className="button-ghost compact-button" onClick={() => addJournalLine()}>
            Add line
          </button>
          <button type="button" className="button-ghost compact-button" onClick={() => saveJournal()} disabled={journalWorking}>
            Save
          </button>
          {journal.journal_status === "draft" ? (
            <>
              <button type="button" className="button-primary" onClick={() => postJournal()} disabled={journalWorking}>
                Post
              </button>
              <button type="button" className="button-ghost compact-button" onClick={() => cancelJournal()} disabled={journalWorking}>
                Cancel
              </button>
            </>
          ) : null}
        </div>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <FieldLabel label="Journal date">
            <input
              type="date"
              value={journal.journal_date ? String(journal.journal_date).slice(0, 10) : ""}
              onChange={(e) => setJournal((prev) => ({ ...(prev || {}), journal_date: e.target.value }))}
              disabled={journal.journal_status !== "draft"}
              style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
            />
          </FieldLabel>
          <FieldLabel label="Narration">
            <input
              value={journal.narration || ""}
              onChange={(e) => setJournal((prev) => ({ ...(prev || {}), narration: e.target.value }))}
              disabled={journal.journal_status !== "draft"}
              style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
            />
          </FieldLabel>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <DeskChip label={`Dr ${money(journalTotals.debit)}`} tone="#f6f7fb" color="#58627a" />
          <DeskChip label={`Cr ${money(journalTotals.credit)}`} tone="#f6f7fb" color="#58627a" />
          <DeskChip
            label={`Diff ${money(journalTotals.diff)}`}
            tone={Math.abs(journalTotals.diff) < 0.005 ? "#effcf3" : "#fff2f3"}
            color={Math.abs(journalTotals.diff) < 0.005 ? "#0b7d45" : "#9f2042"}
          />
          <DeskChip label={journal.journal_status} tone={statusAppearance(journal.journal_status).tone} color={statusAppearance(journal.journal_status).color} />
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {journalLines.length ? (
            journalLines.map((row, index) => (
              <div
                key={index}
                style={{
                  border: "1px solid #e6ebf2",
                  borderRadius: 16,
                  padding: 12,
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "2fr 1fr 1fr 2fr auto",
                  alignItems: "center",
                }}
              >
                <select
                  value={row.account_id}
                  onChange={(e) => updateJournalLine(index, { account_id: e.target.value })}
                  disabled={journal.journal_status !== "draft"}
                  style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
                >
                  {accounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.account_code} · {acct.account_name}
                    </option>
                  ))}
                </select>
                <input
                  value={row.debit}
                  onChange={(e) => updateJournalLine(index, { debit: e.target.value, credit: e.target.value ? "" : row.credit })}
                  disabled={journal.journal_status !== "draft"}
                  placeholder="Debit"
                  style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1", textAlign: "right" }}
                />
                <input
                  value={row.credit}
                  onChange={(e) => updateJournalLine(index, { credit: e.target.value, debit: e.target.value ? "" : row.debit })}
                  disabled={journal.journal_status !== "draft"}
                  placeholder="Credit"
                  style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1", textAlign: "right" }}
                />
                <input
                  value={row.line_remarks}
                  onChange={(e) => updateJournalLine(index, { line_remarks: e.target.value })}
                  disabled={journal.journal_status !== "draft"}
                  placeholder="Line remarks"
                  style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f1" }}
                />
                <button type="button" className="button-ghost compact-button" onClick={() => removeJournalLine(index)} disabled={journal.journal_status !== "draft"}>
                  Remove
                </button>
              </div>
            ))
          ) : (
            <div style={{ opacity: 0.72 }}>No lines yet.</div>
          )}
        </div>
      </div>
    </DeskCard>
  ) : null;

  const journalsPanel = (
    <div style={{ display: "grid", gap: 14 }}>
      {journalView.type === "detail" ? journalDetail : null}
      {journalView.type === "list" ? journalsList : null}
    </div>
  );

  const trialPanel = (
    <div style={{ display: "grid", gap: 14 }}>
      <DeskCard
        title="Trial balance"
        subtitle={trialLoading ? "Loading…" : trial?.rows?.length ? `${trial.rows.length} accounts` : "Posted journals only"}
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input value={trialFrom} onChange={(e) => setTrialFrom(e.target.value)} type="date" style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1" }} />
            <input value={trialTo} onChange={(e) => setTrialTo(e.target.value)} type="date" style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1" }} />
            <button type="button" className="button-ghost compact-button" onClick={() => loadTrialBalance()}>
              Run
            </button>
          </div>
        }
      >
        {trial?.totals ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <DeskChip label={`Period Dr ${money(trial.totals.period_debit)}`} tone="#f6f7fb" color="#58627a" />
            <DeskChip label={`Period Cr ${money(trial.totals.period_credit)}`} tone="#f6f7fb" color="#58627a" />
            <DeskChip label={`Diff ${money(trial.totals.diff)}`} tone={Math.abs(num(trial.totals.diff)) < 0.005 ? "#effcf3" : "#fff2f3"} color={Math.abs(num(trial.totals.diff)) < 0.005 ? "#0b7d45" : "#9f2042"} />
          </div>
        ) : null}
        {Array.isArray(trial?.rows) && trial.rows.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e6ebf2" }}>Account</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Opening Dr</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Opening Cr</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Period Dr</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Period Cr</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Closing Dr</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e6ebf2", width: 110 }}>Closing Cr</th>
                </tr>
              </thead>
              <tbody>
                {trial.rows.map((row) => (
                  <tr key={row.account_id}>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f3f8" }}>
                      <div style={{ fontWeight: 800 }}>
                        {row.account_code} · {row.account_name}
                      </div>
                      <div style={{ opacity: 0.68, fontSize: 12 }}>
                        {String(row.account_type || "").toUpperCase()} · Normal {row.normal_balance}
                      </div>
                    </td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.opening_debit)}</td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.opening_credit)}</td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.period_debit)}</td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.period_credit)}</td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.closing_debit)}</td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f0f3f8", fontFamily: "monospace" }}>{money(row.closing_credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ opacity: 0.72 }}>No posted activity found in this range.</div>
        )}
      </DeskCard>
    </div>
  );

  const content = panel === "accounts" ? accountsPanel : panel === "journals" ? journalsPanel : trialPanel;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <DeskTopStrip
        title="GL Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => loadSummary()}>
              Refresh
            </button>
            <button type="button" onClick={() => createJournal()} disabled={journalsLoading}>
              New journal
            </button>
            <button type="button" onClick={() => bootstrapCoa()} disabled={accountsLoading}>
              Bootstrap COA
            </button>
          </div>
        }
        metrics={topMetrics}
      />
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr minmax(240px, 320px)", gap: 14, alignItems: "start" }}>
        {content}
        {leftPanel}
      </div>
    </div>
  );
}
