import { useEffect, useState } from "react";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || "Request failed");
    err.data = data;
    throw err;
  }
  return data;
}

const CHANNELS = ["website", "google_lead_form", "meta_lead_form", "linkedin_lead_form", "whatsapp", "telephony_tollfree", "qr_form"];

export default function LeadIngestionAdmin() {
  const [endpoints, setEndpoints] = useState([]);
  const [channel, setChannel] = useState("website");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastKey, setLastKey] = useState("");

  async function load() {
    const data = await apiFetch("/leads/ingest/endpoints");
    setEndpoints(data.endpoints || []);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message || "Failed to load ingest endpoints"));
  }, []);

  async function createOrRotate() {
    setBusy(true);
    setError("");
    setNotice("");
    setLastKey("");
    try {
      const data = await apiFetch("/leads/ingest/endpoints", {
        method: "POST",
        body: JSON.stringify({ channel, notes }),
      });
      setLastKey(data.api_key || "");
      setNotice(`Endpoint ready for ${data.endpoint?.channel || channel}. Copy the API key now — it is shown once.`);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save endpoint");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, padding: "8px 0 24px" }}>
      <h2 style={{ margin: 0 }}>Lead Ingestion</h2>
      <p style={{ color: "#64748b", lineHeight: 1.55 }}>
        Manage channel API keys for website / Google / Meta / LinkedIn / WhatsApp / telephony / QR forms.
      </p>
      {error ? <div style={{ color: "#b91c1c" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#15803d" }}>{notice}</div> : null}
      {lastKey ? (
        <div style={{ marginTop: 10, padding: 12, background: "#fff7ed", border: "1px solid #fdba74", borderRadius: 10 }}>
          <div style={{ fontWeight: 700 }}>API key (copy once)</div>
          <code style={{ display: "block", marginTop: 6, wordBreak: "break-all" }}>{lastKey}</code>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>Channel</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, flex: 1, minWidth: 200 }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
        </label>
        <button type="button" disabled={busy} onClick={createOrRotate}>
          {busy ? "Saving…" : "Create / rotate key"}
        </button>
      </div>

      <table style={{ width: "100%", marginTop: 18, borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#64748b" }}>
            <th style={{ padding: "6px 4px" }}>Channel</th>
            <th>Enabled</th>
            <th>Notes</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: 16, color: "#94a3b8" }}>
                No endpoints yet.
              </td>
            </tr>
          ) : (
            endpoints.map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                <td style={{ padding: "8px 4px" }}>{row.channel}</td>
                <td>{row.is_enabled ? "Yes" : "No"}</td>
                <td>{row.notes || "—"}</td>
                <td>{row.created_at ? new Date(row.created_at).toLocaleString("en-IN") : "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
