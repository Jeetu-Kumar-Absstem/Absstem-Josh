import { useEffect, useState } from "react";
import { draftBodyForConfirm } from "../shared/aiDrafts";

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

/**
 * Human-in-the-loop confirm card for deterministic AI drafts.
 * Never writes until Confirm is clicked.
 */
export default function ConfirmDraftCard({
  draft = null,
  onCancel = null,
  onConfirmed = null,
  onError = null,
  /** Optional local edit for remarks / promised amount before confirm */
  editableRemarks = false,
  editablePromisedAmount = false,
}) {
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [promisedAmount, setPromisedAmount] = useState("");
  const [fieldValues, setFieldValues] = useState({});
  const [localError, setLocalError] = useState("");

  const editableFields = Array.isArray(draft?.editableFields) ? draft.editableFields : [];

  useEffect(() => {
    if (!draft) return;
    setRemarks(String(draft.payload?.remarks || ""));
    setPromisedAmount(
      draft.payload?.promised_amount != null && draft.payload?.promised_amount !== ""
        ? String(draft.payload.promised_amount)
        : ""
    );
    const nextFields = {};
    for (const field of Array.isArray(draft.editableFields) ? draft.editableFields : []) {
      const key = field?.key;
      if (!key) continue;
      const raw = draft.payload?.[key];
      nextFields[key] = raw == null ? "" : String(raw);
    }
    setFieldValues(nextFields);
    setLocalError("");
    setBusy(false);
  }, [draft?.id]);

  if (!draft) return null;

  const confidenceTone =
    draft.confidence === "high" ? { bg: "#effcf3", color: "#0b7d45" } : draft.confidence === "medium" ? { bg: "#fff7ea", color: "#8b5a00" } : { bg: "#f6f7fb", color: "#58627a" };
  const sourceLabel = draft.sourceLabel || (draft.source === "deterministic" ? "rules" : draft.source || "rules");

  async function confirm() {
    setBusy(true);
    setLocalError("");
    try {
      const editedPayload = { ...(draft.payload || {}) };
      for (const field of editableFields) {
        const key = field?.key;
        if (!key) continue;
        const raw = fieldValues[key];
        if (field.type === "number") {
          editedPayload[key] = raw === "" || raw == null ? null : Number(raw);
        } else if (field.type === "boolean") {
          editedPayload[key] = raw === true || raw === "true" || raw === "1";
        } else {
          editedPayload[key] = raw == null ? "" : String(raw);
        }
      }
      if (editableRemarks) editedPayload.remarks = remarks;
      if (editablePromisedAmount && draft.payload?.action_type === "promise_to_pay") {
        editedPayload.promised_amount = Number(promisedAmount || 0);
      }

      const working = {
        ...draft,
        payload: editedPayload,
      };
      if (editablePromisedAmount && working.payload.action_type === "promise_to_pay") {
        const amt = Number(working.payload.promised_amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          setLocalError("Promised amount must be greater than 0.");
          setBusy(false);
          return;
        }
      }

      // Local / navigate drafts — human confirmed, no API write here.
      if (working.confirmMode === "local" || !working.confirmEndpoint) {
        onConfirmed?.(null, working);
        return;
      }

      const data = await apiFetch(working.confirmEndpoint, {
        method: working.confirmMethod || "POST",
        body: draftBodyForConfirm(working),
      });
      onConfirmed?.(data, working);
    } catch (e) {
      const message = e?.data?.error || e?.message || "Failed to confirm draft.";
      setLocalError(message);
      onError?.(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm-draft-card" role="region" aria-label="Draft action for confirmation">
      <div className="confirm-draft-head">
        <div>
          <div className="confirm-draft-kicker">Draft · confirm to save</div>
          <strong className="confirm-draft-title">{draft.title}</strong>
          <p className="confirm-draft-rationale">{draft.rationale}</p>
        </div>
        <span className="confirm-draft-pill" style={{ background: confidenceTone.bg, color: confidenceTone.color }}>
          {String(draft.confidence || "medium").toUpperCase()} · {sourceLabel}
        </span>
      </div>

      <div className="confirm-draft-summary">
        {(draft.summary || []).map((row) => (
          <div key={`${row.label}-${row.value}`} className="confirm-draft-summary-row">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>

      {editableFields.length ? (
        <div className="confirm-draft-edit-grid">
          {editableFields.map((field) => (
            <label key={field.key} className="confirm-draft-field">
              <span>{field.label || field.key}</span>
              {field.type === "textarea" ? (
                <textarea
                  rows={field.rows || 3}
                  value={fieldValues[field.key] || ""}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              ) : (
                <input
                  type={field.type === "number" ? "number" : "text"}
                  value={fieldValues[field.key] || ""}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      ) : null}

      {editableRemarks ? (
        <label className="confirm-draft-field">
          <span>Remarks (editable)</span>
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} />
        </label>
      ) : null}

      {editablePromisedAmount && draft.payload?.action_type === "promise_to_pay" ? (
        <label className="confirm-draft-field">
          <span>Promised amount</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={promisedAmount}
            onChange={(e) => setPromisedAmount(e.target.value)}
          />
        </label>
      ) : null}

      {localError ? <div className="confirm-draft-error">{localError}</div> : null}

      <div className="confirm-draft-actions">
        <button type="button" className="button-primary" onClick={confirm} disabled={busy}>
          {busy ? "Saving…" : draft.confirmLabel || "Confirm"}
        </button>
        <button type="button" className="button-ghost" onClick={() => onCancel?.()} disabled={busy}>
          {draft.cancelLabel || "Cancel"}
        </button>
      </div>
    </div>
  );
}
