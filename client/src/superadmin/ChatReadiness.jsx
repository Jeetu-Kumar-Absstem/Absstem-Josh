import { useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const STATES = {
  ready: { label: "Ready", tone: "#14804a", bg: "#ecfdf3", help: "Last alert reached them in Google Chat." },
  untested: { label: "Not tested", tone: "#234a8f", bg: "#eef4ff", help: "No alert has been sent yet. Send a test." },
  needs_google_sign_in: { label: "Needs Google sign-in", tone: "#8b5a00", bg: "#fff9ec", help: "Ask them to sign in to Josh once with Google." },
  app_not_installed: { label: "Chat app not added", tone: "#b45309", bg: "#fff7ed", help: "They need to add the Josh app in Google Chat (or the admin installs it for the domain)." },
  failing: { label: "Failing", tone: "#b00020", bg: "#fff3f3", help: "The last alert failed. See the reason." },
  outside_domain: { label: "Outside domain", tone: "#475569", bg: "#f1f5f9", help: "Email is not on the company Google domain, so Chat can't reach them. They still get in-app and push alerts." },
  chat_not_configured: { label: "Chat off", tone: "#475569", bg: "#f1f5f9", help: "Google Chat alerts are not configured on this server." },
};

const FILTERS = [
  { value: "attention", label: "Needs attention" },
  { value: "all", label: "Everyone" },
  ...Object.entries(STATES).map(([value, s]) => ({ value, label: s.label })),
];

const ATTENTION = new Set(["untested", "needs_google_sign_in", "app_not_installed", "failing"]);

function formatWhen(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function StatusCard({ title, ok, lines }) {
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: ok ? "#f6fef9" : "#fffaf0" }}>
      <div style={{ fontWeight: 800, color: ok ? "#14804a" : "#8b5a00" }}>
        {title}: {ok ? "working" : "not set up"}
      </div>
      {lines.filter(Boolean).map((line) => (
        <div key={line} style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export default function ChatReadiness() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("attention");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await apiFetch("/notifications/chat-readiness"));
    } catch (e) {
      setError(e?.data?.error || "Failed to load Chat readiness.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function sendTest(user) {
    setBusyId(user.id);
    try {
      const res = await apiFetch(`/notifications/chat-readiness/${user.id}/test`, { method: "POST", body: "{}" });
      const chat = res?.channels?.chat_dm;
      const reason = chat?.reason || chat?.error;
      if (chat?.ok) toast(`Test alert reached ${user.full_name} in Google Chat.`, "success");
      else toast(`Test sent to ${user.full_name}, but Chat did not deliver${reason ? `: ${reason}` : ""}.`, "error");
      await load();
    } catch (e) {
      toast(e?.data?.error || "Test alert failed.", "error");
    } finally {
      setBusyId(null);
    }
  }

  const users = Array.isArray(data?.users) ? data.users : [];
  const counts = data?.counts || {};
  const attentionCount = [...ATTENTION].reduce((sum, key) => sum + (counts[key] || 0), 0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "attention" && !ATTENTION.has(u.state)) return false;
      if (filter !== "attention" && filter !== "all" && u.state !== filter) return false;
      if (!q) return true;
      return `${u.full_name || ""} ${u.email || ""} ${u.group_name || ""}`.toLowerCase().includes(q);
    });
  }, [users, filter, query]);

  const chat = data?.chat || {};
  const gmail = data?.gmail_delegation || {};

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 16 }}>
      <section style={{ border: "1px solid #dfe5ef", borderRadius: 24, padding: 22, background: "#fff" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.6 }}>Alerts</div>
        <h2 style={{ margin: "4px 0 6px" }}>Google Chat readiness</h2>
        <div style={{ fontSize: 13, color: "#475569" }}>
          Who will actually receive Josh alerts (approvals, quote hand-offs, cover requests) in Google Chat, and whose quotes can be
          sent from their own mailbox.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 14 }}>
          <StatusCard
            title="Google Chat alerts"
            ok={Boolean(chat.enabled && chat.configured)}
            lines={[chat.domain ? `Domain: ${chat.domain}` : "", chat.app_account ? `App account: ${chat.app_account}` : ""]}
          />
          <StatusCard
            title="Send quotes from the owner's mailbox"
            ok={Boolean(gmail.enabled && gmail.configured)}
            lines={[
              gmail.domain ? `Domain: ${gmail.domain}` : "",
              gmail.client_id ? `Service account client ID: ${gmail.client_id}` : "",
              gmail.enabled && gmail.configured ? "" : "Without it, quotes go from the sender's own mailbox with the owner in CC.",
            ]}
          />
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14 }}>
            <div style={{ fontWeight: 800 }}>{users.length} active users</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
              {counts.ready || 0} ready · {attentionCount} need attention · {counts.outside_domain || 0} outside domain
            </div>
          </div>
        </div>
      </section>

      <section style={{ border: "1px solid #dfe5ef", borderRadius: 24, padding: 18, background: "#fff" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ height: 34 }}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
                {f.value === "attention" ? ` (${attentionCount})` : f.value !== "all" && counts[f.value] ? ` (${counts[f.value]})` : ""}
              </option>
            ))}
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email, group" style={{ height: 34, padding: "0 10px", minWidth: 240 }} />
          <button type="button" onClick={() => load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {error ? <div style={{ color: "#b00020", marginBottom: 10 }}>{error}</div> : null}
        {!loading && !rows.length ? (
          <div style={{ fontSize: 13, color: "#64748b", padding: 12 }}>
            {filter === "attention" ? "Nobody needs attention right now." : "No users match this filter."}
          </div>
        ) : null}
        {rows.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: 12 }}>
                  <th style={{ padding: 8 }}>Person</th>
                  <th style={{ padding: 8 }}>Chat status</th>
                  <th style={{ padding: 8 }}>Last delivered</th>
                  <th style={{ padding: 8 }}>Send-as</th>
                  <th style={{ padding: 8 }}>Push devices</th>
                  <th style={{ padding: 8 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const s = STATES[u.state] || { label: u.state, tone: "#475569", bg: "#f1f5f9", help: "" };
                  const testable = u.state !== "chat_not_configured" && u.state !== "outside_domain";
                  return (
                    <tr key={u.id} style={{ borderTop: "1px solid #eef2f7", verticalAlign: "top" }}>
                      <td style={{ padding: 8 }}>
                        <div style={{ fontWeight: 700 }}>{u.full_name || "—"}</div>
                        <div style={{ fontSize: 12, color: "#64748b" }}>
                          {u.email} · {u.group_name || "—"}
                        </div>
                      </td>
                      <td style={{ padding: 8, maxWidth: 360 }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, background: s.bg, color: s.tone, fontWeight: 700, fontSize: 12 }}>
                          {s.label}
                        </span>
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{s.help}</div>
                        {u.state === "failing" && u.last_reason ? (
                          <div style={{ fontSize: 12, color: "#b00020", marginTop: 2 }}>Reason: {u.last_reason}</div>
                        ) : null}
                      </td>
                      <td style={{ padding: 8, fontSize: 12 }}>
                        {formatWhen(u.last_ok_at)}
                        {u.last_attempt_at && u.last_attempt_at !== u.last_ok_at ? (
                          <div style={{ color: "#64748b" }}>Last try: {formatWhen(u.last_attempt_at)}</div>
                        ) : null}
                      </td>
                      <td style={{ padding: 8, fontSize: 12 }}>{u.can_send_as ? "Yes" : "No"}</td>
                      <td style={{ padding: 8, fontSize: 12 }}>{u.push_devices || 0}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>
                        {testable ? (
                          <button type="button" onClick={() => sendTest(u)} disabled={busyId === u.id}>
                            {busyId === u.id ? "Sending…" : "Send test"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
