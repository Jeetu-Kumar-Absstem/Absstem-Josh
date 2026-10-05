import { useState } from "react";
import { canUploadDrive } from "../shared/driveAccess";

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

async function apiFetchForm(path, formData) {
  const res = await fetch(path, {
    credentials: "include",
    body: formData,
    method: "POST",
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Complete commissioning — warranty + milestone unlock via backend gates.
 */
export default function CommissioningCompletionModal({ me, ticket, onClose, onCompleted }) {
  const [piping, setPiping] = useState(ticket?.piping_infrastructure_status || "");
  const [welding, setWelding] = useState(ticket?.welding_finish_notes || "");
  const [signoffDate, setSignoffDate] = useState(ticket?.client_signoff_date || todayIso());
  const [driveFileId, setDriveFileId] = useState(ticket?.drive_file_id || null);
  const [uploadedName, setUploadedName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canUpload = canUploadDrive(me, "service_amc");

  async function uploadSignedPdf(file) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (ticket?.company_id) fd.append("company_id", String(ticket.company_id));
      fd.append("owner_ref", `commissioning:${ticket.id}`);
      const data = await apiFetchForm("/drive/upload/service_amc", fd);
      const fileRow = data?.file;
      if (!fileRow?.id) throw Object.assign(new Error("Upload failed"), { data: { error: "UPLOAD_EMPTY" } });
      setDriveFileId(fileRow.id);
      setUploadedName(fileRow.file_name || file.name);
    } catch (err) {
      setError([err?.data?.error, err?.data?.detail].filter(Boolean).join(": ") || "Signed PDF upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!signoffDate) {
      setError("Client sign-off date is required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const data = await apiFetch(`/field-service/tickets/${ticket.id}/complete`, {
        method: "PATCH",
        body: JSON.stringify({
          client_signoff_date: signoffDate,
          piping_infrastructure_status: piping,
          welding_finish_notes: welding,
          drive_file_id: driveFileId || undefined,
        }),
      });
      onCompleted?.(data);
    } catch (err) {
      setError([err?.data?.error, err?.data?.detail].filter(Boolean).join(": ") || "Complete failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        zIndex: 80,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          borderRadius: 18,
          background: "#fff",
          border: "1px solid #dfe5ef",
          padding: 18,
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Complete commissioning</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>
              {ticket?.so_number || `SO #${ticket?.sales_order_id}`} · {ticket?.customer_name || "Customer"}
            </div>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
              Submitting starts warranty clocks and unlocks locked commissioning milestones.
            </div>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? <div style={{ color: "#9f1428", marginTop: 12, fontSize: 13 }}>{error}</div> : null}

        <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#42506b" }}>
              Client sign-off date
            </span>
            <input type="date" value={signoffDate} onChange={(e) => setSignoffDate(e.target.value)} disabled={submitting} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#42506b" }}>
              Piping / infrastructure status
            </span>
            <textarea
              rows={3}
              value={piping}
              onChange={(e) => setPiping(e.target.value)}
              disabled={submitting}
              placeholder="On-site modifications, replacements, as-built notes…"
              style={{ width: "100%", borderRadius: 10, border: "1px solid #c5d0e0", padding: 10 }}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#42506b" }}>
              Welding / finish notes
            </span>
            <textarea
              rows={3}
              value={welding}
              onChange={(e) => setWelding(e.target.value)}
              disabled={submitting}
              placeholder="Weld finish, NDT, paint, punch-list closure…"
              style={{ width: "100%", borderRadius: 10, border: "1px solid #c5d0e0", padding: 10 }}
            />
          </label>

          <div style={{ border: "1px dashed #c5d0e0", borderRadius: 12, padding: 12, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Signed client PDF (Drive proxy · service_amc)</div>
            {canUpload ? (
              <input
                type="file"
                accept=".pdf,application/pdf"
                disabled={uploading || submitting}
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0];
                  if (file) uploadSignedPdf(file).catch(() => {});
                }}
              />
            ) : (
              <div style={{ fontSize: 12, opacity: 0.7 }}>Your role cannot upload service files. Ask Service/Aftermarket to attach the signed PDF.</div>
            )}
            {uploading ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Uploading…</div> : null}
            {driveFileId ? (
              <div style={{ fontSize: 12, color: "#0b7d45", marginTop: 6 }}>
                Attached registry id {driveFileId}
                {uploadedName ? ` · ${uploadedName}` : ""}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={submitting || uploading || !signoffDate}>
            {submitting ? "Submitting…" : "Submit & lock"}
          </button>
        </div>
      </div>
    </div>
  );
}
