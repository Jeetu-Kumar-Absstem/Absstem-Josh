import { useEffect, useState } from "react";
import TypedConfirmModal from "../components/TypedConfirmModal";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export default function DataOpsDesk() {
  const [ops, setOps] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedOp, setSelectedOp] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function refresh() {
    const [catalog, runList] = await Promise.all([
      apiFetch("/api/data-ops/catalog"),
      apiFetch("/api/data-ops/runs"),
    ]);
    setOps(catalog.ops || []);
    setRuns(runList.runs || []);
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message || "Failed to load Data Ops"));
  }, []);

  async function runDry() {
    if (!selectedOp) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/api/data-ops/run", {
        method: "POST",
        body: JSON.stringify({ op_key: selectedOp.key, apply: false }),
      });
      setPreview(data.result || null);
      setNotice(`Dry-run complete for ${selectedOp.label}.`);
      await refresh();
    } catch (e) {
      setError(e.message || "Dry-run failed");
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!selectedOp) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/api/data-ops/run", {
        method: "POST",
        body: JSON.stringify({
          op_key: selectedOp.key,
          apply: true,
          confirm_phrase: selectedOp.confirmPhrase,
        }),
      });
      setPreview(data.result || null);
      setNotice(`Applied ${selectedOp.label}.`);
      setConfirmOpen(false);
      await refresh();
    } catch (e) {
      setError(e.message || e?.data?.error || "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, padding: "8px 0 24px" }}>
      <h2 style={{ margin: 0, fontSize: 28 }}>Data Ops</h2>
      <p style={{ color: "#64748b", maxWidth: 720, lineHeight: 1.55 }}>
        Day-2 repairs leave the CLI through dry-run → preview → typed confirm → audit. Destructive wipe apply stays CLI-only.
      </p>

      {error ? <div style={{ color: "#b91c1c", marginBottom: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#15803d", marginBottom: 12 }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #dbe3f0", borderRadius: 14, padding: 12, background: "#fff" }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>
            Operations
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {ops.map((op) => (
              <button
                key={op.key}
                type="button"
                onClick={() => {
                  setSelectedOp(op);
                  setPreview(null);
                }}
                style={{
                  textAlign: "left",
                  border: selectedOp?.key === op.key ? "1px solid #1d4ed8" : "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: 10,
                  background: selectedOp?.key === op.key ? "#eff6ff" : "#f8fafc",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 700 }}>{op.label}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{op.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ border: "1px solid #dbe3f0", borderRadius: 14, padding: 16, background: "#fff" }}>
          {selectedOp ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{selectedOp.label}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>{selectedOp.description}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                <button type="button" disabled={busy} onClick={runDry}>
                  {busy ? "Working…" : "1. Dry-run / Preview"}
                </button>
                <button
                  type="button"
                  disabled={busy || selectedOp.applyBlocked || !preview}
                  onClick={() => setConfirmOpen(true)}
                >
                  2. Apply with typed confirm
                </button>
              </div>
              {selectedOp.applyBlocked ? (
                <div style={{ marginTop: 10, fontSize: 12, color: "#b45309" }}>
                  Apply is blocked here — use the CLI script after reviewing the preview counts.
                </div>
              ) : null}
              {preview ? (
                <pre
                  style={{
                    marginTop: 14,
                    maxHeight: 360,
                    overflow: "auto",
                    background: "#0f172a",
                    color: "#e2e8f0",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 12,
                  }}
                >
                  {JSON.stringify(preview, null, 2)}
                </pre>
              ) : (
                <div style={{ marginTop: 16, color: "#94a3b8", fontSize: 13 }}>Run a dry-run to see preview payload.</div>
              )}
            </>
          ) : (
            <div style={{ color: "#94a3b8" }}>Select an operation.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 20, border: "1px solid #dbe3f0", borderRadius: 14, padding: 14, background: "#fff" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Recent runs</div>
        {runs.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 13 }}>No runs yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "6px 4px" }}>When</th>
                <th>Op</th>
                <th>Mode</th>
                <th>Actor</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={{ padding: "8px 4px" }}>{new Date(run.created_at).toLocaleString("en-IN")}</td>
                  <td>{run.op_key}</td>
                  <td>{run.mode}</td>
                  <td>{run.actor_name || run.actor_email || "—"}</td>
                  <td>{run.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <TypedConfirmModal
        open={confirmOpen}
        title={`Apply ${selectedOp?.label || "operation"}`}
        message="This writes to live operational tables. Type the confirm phrase exactly."
        confirmPhrase={selectedOp?.confirmPhrase || "CONFIRM"}
        confirmLabel="Apply now"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={runApply}
      />
    </div>
  );
}
